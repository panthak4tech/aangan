use crate::{
    catalog,
    runtime::{self, InstalledRuntime},
    storage,
};
#[cfg(windows)]
use aangan_runtime::supervise::job::KillOnCloseJob;
use aangan_runtime::supervise::{
    ApiKeyMode, LaunchParams, api_key_mode, build_args, is_blocked_env, loopback_status,
    random_key, redact,
};
use fitcalc::{Placement, Tunables, recommend};
use hwprobe::{ProbeOptions, probe};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

const LOG_LIMIT: usize = 5_000;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(180);
const KEY_ENV_NAMES: [&str; 2] = ["LLAMA_API_KEY", "LLAMA_ARG_API_KEY"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RuntimeState {
    Stopped,
    Starting,
    Ready,
    Stopping,
    Failed {
        exit_code: Option<i32>,
        last_lines: Vec<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    pub port: Option<u16>,
    pub api_key_visible: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEndpoint {
    pub base_url: String,
    pub key: String,
}

struct RunningProcess {
    child: Child,
    key: String,
}

pub struct RuntimeSupervisor {
    inner: Arc<SupervisorInner>,
}

struct SupervisorInner {
    state: Mutex<RuntimeState>,
    running: Mutex<Option<RunningProcess>>,
    logs: Mutex<VecDeque<String>>,
    port: Mutex<Option<u16>>,
    data_dir: PathBuf,
    app: AppHandle,
    #[cfg(windows)]
    job: Mutex<Option<KillOnCloseJob>>,
}

impl RuntimeSupervisor {
    pub fn new(app: AppHandle, data_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(SupervisorInner {
                state: Mutex::new(RuntimeState::Stopped),
                running: Mutex::new(None),
                logs: Mutex::new(VecDeque::with_capacity(LOG_LIMIT)),
                port: Mutex::new(None),
                data_dir,
                app,
                #[cfg(windows)]
                job: Mutex::new(None),
            }),
        }
    }

    pub fn state(&self) -> RuntimeStatus {
        let state = self
            .inner
            .state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or(RuntimeState::Failed {
                exit_code: None,
                last_lines: vec!["Supervisor state is unavailable.".into()],
            });
        let port = self.inner.port.lock().ok().and_then(|guard| *guard);
        let api_key_visible = matches!(state, RuntimeState::Ready);
        RuntimeStatus {
            state,
            port,
            api_key_visible,
        }
    }

    pub fn logs(&self) -> Vec<String> {
        self.inner
            .logs
            .lock()
            .map(|guard| guard.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn clear_logs(&self) {
        if let Ok(mut logs) = self.inner.logs.lock() {
            logs.clear();
        }
    }

    pub fn endpoint(&self) -> Option<RuntimeEndpoint> {
        let state = self.inner.state.lock().ok()?;
        if !matches!(*state, RuntimeState::Ready) {
            return None;
        }
        let port_guard = self.inner.port.lock().ok()?;
        let port = (*port_guard)?;
        let running = self.inner.running.lock().ok()?;
        let key = running.as_ref()?.key.clone();
        Some(RuntimeEndpoint {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            key,
        })
    }

    pub fn start(&self, model_id: &str, ctx: u32) -> Result<RuntimeStatus, String> {
        if matches!(
            self.state().state,
            RuntimeState::Starting | RuntimeState::Ready
        ) {
            return Err("A runtime is already starting or running.".into());
        }
        let settings = runtime::load_settings(&self.inner.data_dir)?;
        let key = settings.default_runtime.ok_or_else(|| {
            "No default runtime is installed. Install one in Runtimes.".to_string()
        })?;
        let installed = runtime::installed_runtimes(&self.inner.data_dir, None)?
            .into_iter()
            .find(|runtime| {
                runtime.runtime_id == key.runtime_id
                    && runtime.version == key.version
                    && runtime.variant == key.variant
            })
            .ok_or_else(|| "The default runtime is not installed.".to_string())?;
        let model = find_downloaded_model(&self.inner.data_dir, model_id)?;
        let exe = find_server_exe(&installed, &self.inner.data_dir)?;
        let gpu_layers = gpu_layers_for_model(&self.inner.data_dir, model_id, ctx)?;
        let port = aangan_runtime::supervise::free_loopback_port()
            .map_err(|error| format!("could not reserve a loopback port: {error}"))?;
        let api_key = random_key();
        let params = LaunchParams {
            exe: exe.clone(),
            model,
            port,
            ctx: ctx.max(1),
            gpu_layers,
            threads: None,
        };
        let key_mode = api_key_mode(&exe).unwrap_or(ApiKeyMode::Environment);
        let mut command = Command::new(&exe);
        for arg in build_args(&params) {
            command.arg(arg);
        }
        if key_mode == ApiKeyMode::Argument {
            command.arg("--api-key").arg(&api_key);
        }
        command
            .current_dir(&installed.path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, _value) in env::vars_os() {
            let name_text = name.to_string_lossy();
            if is_blocked_env(&name_text) {
                command.env_remove(name);
            }
        }
        if key_mode == ApiKeyMode::Environment {
            for name in KEY_ENV_NAMES {
                command.env(name, &api_key);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("could not start llama-server: {error}"))?;
        #[cfg(windows)]
        {
            let job = KillOnCloseJob::new()
                .map_err(|error| format!("could not create process kill switch: {error}"))?;
            job.assign(&child).map_err(|error| {
                format!("could not assign llama-server to kill switch: {error}")
            })?;
            if let Ok(mut job_guard) = self.inner.job.lock() {
                *job_guard = Some(job);
            }
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        push_state(&self.inner, RuntimeState::Starting);
        if let Ok(mut port_guard) = self.inner.port.lock() {
            *port_guard = Some(port);
        }
        if let Ok(mut running) = self.inner.running.lock() {
            *running = Some(RunningProcess {
                child,
                key: api_key.clone(),
            });
        }
        spawn_log_reader(&self.inner, stdout, api_key.clone());
        spawn_log_reader(&self.inner, stderr, api_key);
        spawn_monitor(Arc::clone(&self.inner), port);
        Ok(self.state())
    }

    pub fn stop(&self) -> Result<RuntimeStatus, String> {
        push_state(&self.inner, RuntimeState::Stopping);
        let child_result = self.inner.running.lock().map(|mut guard| guard.take());
        let mut child = match child_result {
            Ok(Some(process)) => process.child,
            Ok(None) => {
                push_state(&self.inner, RuntimeState::Stopped);
                return Ok(self.state());
            }
            Err(_) => {
                return Err("Supervisor process state is unavailable.".into());
            }
        };
        let _ = child.kill();
        #[cfg(windows)]
        {
            if let Ok(mut job) = self.inner.job.lock() {
                let _ = job.take();
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                Ok(None) => break,
                Err(_) => break,
            }
        }
        let _ = child.wait();
        if let Ok(mut port) = self.inner.port.lock() {
            *port = None;
        }
        push_state(&self.inner, RuntimeState::Stopped);
        Ok(self.state())
    }

    pub fn copy_diagnostics(&self) -> String {
        let status = self.state();
        let logs = self.logs();
        let last = logs
            .iter()
            .rev()
            .take(200)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let state = serde_json::to_string(&status.state).unwrap_or_else(|_| "unknown".into());
        let os = std::env::consts::OS;
        let arch = std::env::consts::ARCH;
        let gpu = probe(&ProbeOptions {
            measure_bandwidth: false,
        })
        .ok()
        .and_then(|profile| profile.gpus.into_iter().next())
        .map(|gpu| gpu.name)
        .unwrap_or_else(|| "No GPU detected".into());
        let endpoint_key = self
            .endpoint()
            .map(|endpoint| endpoint.key)
            .unwrap_or_default();
        let last = redact(&last, &endpoint_key);
        format!(
            "Aangan runtime diagnostics\nState: {state}\nOS: {os} {arch}\nGPU: {gpu}\n\nLast 200 log lines:\n{last}"
        )
        .replace(&self.inner.data_dir.to_string_lossy().into_owned(), "<Aangan data folder>")
    }
}

fn push_state(inner: &SupervisorInner, state: RuntimeState) {
    if let Ok(mut guard) = inner.state.lock() {
        *guard = state.clone();
    }
    let status = RuntimeStatus {
        state,
        port: inner.port.lock().ok().and_then(|guard| *guard),
        api_key_visible: false,
    };
    let _ = inner.app.emit("runtime://state", status);
}

fn push_log(inner: &SupervisorInner, line: &str) {
    if let Ok(mut logs) = inner.logs.lock() {
        append_log_line(&mut logs, line);
    }
}

fn append_log_line(logs: &mut VecDeque<String>, line: &str) {
    if logs.len() == LOG_LIMIT {
        logs.pop_front();
    }
    logs.push_back(line.to_string());
}

fn spawn_log_reader(
    inner: &Arc<SupervisorInner>,
    pipe: Option<impl std::io::Read + Send + 'static>,
    secret: String,
) {
    let Some(pipe) = pipe else {
        return;
    };
    let inner = Arc::clone(inner);
    thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    let safe = redact(trimmed, &secret);
                    push_log(&inner, &safe);
                    let _ = inner.app.emit("runtime://log", safe);
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_monitor(inner: Arc<SupervisorInner>, port: u16) {
    thread::spawn(move || {
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        loop {
            thread::sleep(Duration::from_millis(500));
            match inner.running.lock() {
                Ok(mut guard) => {
                    let exited = guard
                        .as_mut()
                        .and_then(|process| process.child.try_wait().ok().flatten());
                    if let Some(status) = exited {
                        let logs = inner
                            .logs
                            .lock()
                            .map(|guard| guard.iter().rev().take(20).rev().cloned().collect())
                            .unwrap_or_default();
                        *guard = None;
                        push_state(
                            &inner,
                            RuntimeState::Failed {
                                exit_code: status.code(),
                                last_lines: logs,
                            },
                        );
                        return;
                    }
                }
                Err(_) => return,
            }
            match loopback_status(port, "/health", Duration::from_millis(800)) {
                Ok(200) => {
                    push_state(&inner, RuntimeState::Ready);
                    return;
                }
                Ok(503) => {}
                Ok(_) => {}
                Err(_) => {}
            }
            if Instant::now() >= deadline {
                let logs = inner
                    .logs
                    .lock()
                    .map(|guard| guard.iter().rev().take(20).rev().cloned().collect())
                    .unwrap_or_default();
                if let Ok(mut guard) = inner.running.lock()
                    && let Some(process) = guard.take()
                {
                    let mut child = process.child;
                    let _ = child.kill();
                    let _ = child.wait();
                }
                push_state(
                    &inner,
                    RuntimeState::Failed {
                        exit_code: None,
                        last_lines: logs,
                    },
                );
                return;
            }
        }
    });
}

fn find_downloaded_model(data_dir: &Path, model_id: &str) -> Result<PathBuf, String> {
    let loaded = catalog::load_catalog(data_dir, crate::BUNDLED_CATALOG)?;
    let storage = storage::storage_info(data_dir, &loaded.catalog)?;
    storage
        .model_files
        .into_iter()
        .find(|file| file.model_id.as_deref() == Some(model_id))
        .map(|file| PathBuf::from(file.path))
        .ok_or_else(|| "The selected model is not downloaded.".into())
}

fn find_server_exe(installed: &InstalledRuntime, data_dir: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(data_dir)
        .map_err(|error| format!("could not resolve Aangan data folder: {error}"))?;
    let runtime_dir = fs::canonicalize(&installed.path)
        .map_err(|error| format!("could not resolve installed runtime: {error}"))?;
    if !runtime_dir.starts_with(root.join("runtimes")) {
        return Err("Installed runtime resolves outside the runtimes folder.".into());
    }
    let record_path = runtime_dir.join("aangan-runtime.json");
    let record_bytes = fs::read(&record_path)
        .map_err(|error| format!("could not read runtime install record: {error}"))?;
    let record: serde_json::Value = serde_json::from_slice(&record_bytes)
        .map_err(|error| format!("invalid install record: {error}"))?;
    let server_exe = record
        .get("serverExe")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Runtime install record has no server executable.".to_string())?;
    if server_exe.contains(['/', '\\']) || server_exe.contains("..") {
        return Err("Runtime server executable path is invalid.".into());
    }
    let exe = runtime_dir.join(server_exe);
    if !exe.is_file() {
        return Err("The installed llama-server executable is missing.".into());
    }
    Ok(exe)
}

fn gpu_layers_for_model(data_dir: &Path, model_id: &str, ctx: u32) -> Result<i32, String> {
    let profile = probe(&ProbeOptions {
        measure_bandwidth: false,
    })
    .map_err(|error| format!("could not probe hardware: {error}"))?;
    let loaded = catalog::load_catalog(data_dir, crate::BUNDLED_CATALOG)?;
    let recommendations = recommend(
        &profile,
        &catalog::model_specs(&loaded.catalog),
        ctx,
        &Tunables::default(),
    );
    let full_gpu = recommendations
        .iter()
        .find(|recommendation| recommendation.model.id == model_id)
        .is_some_and(|recommendation| {
            matches!(recommendation.estimate.placement, Placement::FullGpu)
        });
    Ok(if full_gpu { 999 } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_never_exceeds_5000_lines() {
        let mut logs = VecDeque::new();
        for index in 0..LOG_LIMIT + 25 {
            append_log_line(&mut logs, &format!("line-{index}"));
        }
        assert_eq!(logs.len(), LOG_LIMIT);
        assert_eq!(logs.front().map(String::as_str), Some("line-25"));
        assert_eq!(
            logs.back().map(String::as_str),
            Some(format!("line-{}", LOG_LIMIT + 24).as_str())
        );
    }
}
