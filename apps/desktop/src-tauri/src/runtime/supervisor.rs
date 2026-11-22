use crate::{
    catalog,
    runtime::{self, InstalledRuntime},
    storage,
};
#[cfg(windows)]
use aangan_runtime::supervise::job::KillOnCloseJob;
use aangan_runtime::supervise::{
    ApiKeyMode, LaunchParams, api_key_mode, build_args, loopback_status, random_key, redact,
    remove_blocked_env,
};
use fitcalc::{Placement, Tunables, recommend};
use hwprobe::{ProbeOptions, probe};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
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
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        #[serde(rename = "lastLines")]
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
    session_id: u64,
    child: Child,
    key: String,
    cancel_monitor: Arc<AtomicBool>,
    #[cfg(windows)]
    _job: KillOnCloseJob,
}

struct SupervisorState {
    state: RuntimeState,
    session_id: Option<u64>,
}

impl SupervisorState {
    fn new() -> Self {
        Self {
            state: RuntimeState::Stopped,
            session_id: None,
        }
    }

    fn start_session(&mut self, session_id: u64) {
        self.state = RuntimeState::Starting;
        self.session_id = Some(session_id);
    }

    fn set_unowned(&mut self, state: RuntimeState) {
        self.state = state;
        self.session_id = None;
    }

    fn update_session(&mut self, session_id: u64, state: RuntimeState, finished: bool) -> bool {
        if self.session_id != Some(session_id) {
            return false;
        }
        self.state = state;
        if finished {
            self.session_id = None;
        }
        true
    }
}

pub struct RuntimeSupervisor {
    inner: Arc<SupervisorInner>,
}

struct SupervisorInner {
    state: Mutex<SupervisorState>,
    lifecycle: Mutex<()>,
    next_session_id: AtomicU64,
    running: Mutex<Option<RunningProcess>>,
    logs: Mutex<VecDeque<String>>,
    port: Mutex<Option<u16>>,
    data_dir: PathBuf,
    app: AppHandle,
}

impl RuntimeSupervisor {
    pub fn new(app: AppHandle, data_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(SupervisorInner {
                state: Mutex::new(SupervisorState::new()),
                lifecycle: Mutex::new(()),
                next_session_id: AtomicU64::new(1),
                running: Mutex::new(None),
                logs: Mutex::new(VecDeque::with_capacity(LOG_LIMIT)),
                port: Mutex::new(None),
                data_dir,
                app,
            }),
        }
    }

    pub fn state(&self) -> RuntimeStatus {
        let state = self
            .inner
            .state
            .lock()
            .map(|guard| guard.state.clone())
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
        let is_ready = self
            .inner
            .state
            .lock()
            .ok()
            .is_some_and(|guard| matches!(guard.state, RuntimeState::Ready));
        if !is_ready {
            return None;
        }
        let port = self.inner.port.lock().ok().and_then(|guard| *guard)?;
        let running = self.inner.running.lock().ok()?;
        let key = running.as_ref()?.key.clone();
        Some(RuntimeEndpoint {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            key,
        })
    }

    pub fn start(&self, model_id: &str, ctx: u32) -> Result<RuntimeStatus, String> {
        let _lifecycle = self
            .inner
            .lifecycle
            .lock()
            .map_err(|_| "Supervisor lifecycle state is unavailable.")?;
        if matches!(
            self.state().state,
            RuntimeState::Starting | RuntimeState::Ready
        ) {
            return Err("A runtime is already starting or running.".into());
        }
        if self
            .inner
            .running
            .lock()
            .map_err(|_| "Supervisor process state is unavailable.")?
            .is_some()
        {
            return Err(
                "A previous runtime process must be stopped before starting another.".into(),
            );
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
        let api_key =
            random_key().map_err(|error| format!("could not generate runtime API key: {error}"))?;
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
        remove_blocked_env(&mut command);
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
        let session_id = self.inner.next_session_id.fetch_add(1, Ordering::Relaxed);
        let cancel_monitor = Arc::new(AtomicBool::new(false));
        #[cfg(windows)]
        let job = match KillOnCloseJob::new() {
            Ok(job) => job,
            Err(error) => {
                return Err(abort_spawned_child(
                    &mut child,
                    "could not create process kill switch",
                    error,
                ));
            }
        };
        #[cfg(windows)]
        if let Err(error) = job.assign(&child) {
            return Err(abort_spawned_child(
                &mut child,
                "could not assign llama-server to kill switch",
                error,
            ));
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let process = RunningProcess {
            session_id,
            cancel_monitor: Arc::clone(&cancel_monitor),
            child,
            key: api_key.clone(),
            #[cfg(windows)]
            _job: job,
        };
        let mut running = match self.inner.running.lock() {
            Ok(running) => running,
            Err(_) => {
                let mut process = process;
                let cleanup = terminate_child_and_reap(&mut process.child);
                return Err(format_cleanup_error(
                    "Supervisor process state is unavailable.",
                    cleanup,
                ));
            }
        };
        if running.is_some() {
            let mut process = process;
            let cleanup = terminate_child_and_reap(&mut process.child);
            return Err(format_cleanup_error(
                "A previous runtime process must be stopped before starting another.",
                cleanup,
            ));
        }
        let mut port_guard = match self.inner.port.lock() {
            Ok(port_guard) => port_guard,
            Err(_) => {
                let mut process = process;
                let cleanup = terminate_child_and_reap(&mut process.child);
                return Err(format_cleanup_error(
                    "Supervisor port state is unavailable.",
                    cleanup,
                ));
            }
        };
        *port_guard = Some(port);
        drop(port_guard);
        *running = Some(process);
        if !push_starting_state(&self.inner, session_id) {
            if let Some(mut process) = running.take() {
                process.cancel_monitor.store(true, Ordering::Release);
                let _ = terminate_child_and_reap(&mut process.child);
            }
            if let Ok(mut port_guard) = self.inner.port.lock() {
                *port_guard = None;
            }
            return Err("Supervisor state is unavailable.".into());
        }
        drop(running);
        spawn_log_reader(&self.inner, stdout, api_key.clone());
        spawn_log_reader(&self.inner, stderr, api_key);
        spawn_monitor(Arc::clone(&self.inner), session_id, cancel_monitor, port);
        Ok(self.state())
    }

    pub fn stop(&self) -> Result<RuntimeStatus, String> {
        let _lifecycle = self
            .inner
            .lifecycle
            .lock()
            .map_err(|_| "Supervisor lifecycle state is unavailable.")?;
        let mut running = self
            .inner
            .running
            .lock()
            .map_err(|_| "Supervisor process state is unavailable.")?;
        let process = running.take();
        if let Some(process) = &process {
            process.cancel_monitor.store(true, Ordering::Release);
        }
        push_state(&self.inner, RuntimeState::Stopping);
        drop(running);

        let Some(process) = process else {
            if let Ok(mut port) = self.inner.port.lock() {
                *port = None;
            }
            push_state(&self.inner, RuntimeState::Stopped);
            return Ok(self.state());
        };
        let mut child = process.child;
        let _ = child.kill();
        #[cfg(windows)]
        drop(process._job);
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
    let Ok(mut guard) = inner.state.lock() else {
        return;
    };
    guard.set_unowned(state.clone());
    drop(guard);
    emit_state(inner, state);
}

fn push_starting_state(inner: &SupervisorInner, session_id: u64) -> bool {
    let Ok(mut guard) = inner.state.lock() else {
        return false;
    };
    guard.start_session(session_id);
    drop(guard);
    emit_state(inner, RuntimeState::Starting);
    true
}

fn push_state_for_session(
    inner: &SupervisorInner,
    session_id: u64,
    state: RuntimeState,
    finished: bool,
) -> bool {
    let Ok(mut guard) = inner.state.lock() else {
        return false;
    };
    if !guard.update_session(session_id, state.clone(), finished) {
        return false;
    }
    drop(guard);
    emit_state(inner, state);
    true
}

fn emit_state(inner: &SupervisorInner, state: RuntimeState) {
    let status = RuntimeStatus {
        api_key_visible: matches!(state, RuntimeState::Ready),
        state,
        port: inner.port.lock().ok().and_then(|guard| *guard),
    };
    let _ = inner.app.emit("runtime://state", status);
}

fn terminate_child_and_reap(child: &mut Child) -> Result<(), std::io::Error> {
    let kill_result = child.kill();
    match child.wait() {
        Ok(_) => Ok(()),
        Err(wait_error) => match kill_result {
            Ok(()) => Err(wait_error),
            Err(kill_error) => Err(std::io::Error::other(format!(
                "kill failed: {kill_error}; wait failed: {wait_error}"
            ))),
        },
    }
}

fn format_cleanup_error(context: &str, cleanup: Result<(), std::io::Error>) -> String {
    match cleanup {
        Ok(()) => context.to_string(),
        Err(error) => format!("{context} Child cleanup failed: {error}"),
    }
}

#[cfg(windows)]
fn abort_spawned_child(child: &mut Child, context: &str, error: std::io::Error) -> String {
    match terminate_child_and_reap(child) {
        Ok(()) => format!("{context}: {error}"),
        Err(cleanup_error) => {
            format!("{context}: {error}; could not terminate/reap child: {cleanup_error}")
        }
    }
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

fn spawn_monitor(
    inner: Arc<SupervisorInner>,
    session_id: u64,
    cancel_monitor: Arc<AtomicBool>,
    port: u16,
) {
    thread::spawn(move || {
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        let mut ready = false;
        loop {
            if cancel_monitor.load(Ordering::Acquire) {
                return;
            }
            thread::sleep(Duration::from_millis(500));
            if cancel_monitor.load(Ordering::Acquire) {
                return;
            }

            let mut running = match inner.running.lock() {
                Ok(running) => running,
                Err(_) => return,
            };
            let process_status = {
                let Some(process) = running.as_mut() else {
                    return;
                };
                if process.session_id != session_id
                    || process.cancel_monitor.load(Ordering::Acquire)
                {
                    return;
                }
                process.child.try_wait()
            };
            match process_status {
                Ok(Some(status)) => {
                    let process = running.take();
                    let logs = recent_logs(&inner);
                    if let Ok(mut current_port) = inner.port.lock() {
                        *current_port = None;
                    }
                    push_state_for_session(
                        &inner,
                        session_id,
                        RuntimeState::Failed {
                            exit_code: status.code(),
                            last_lines: logs,
                        },
                        true,
                    );
                    drop(process);
                    return;
                }
                Err(error) => {
                    let Some(mut process) = running.take() else {
                        return;
                    };
                    process.cancel_monitor.store(true, Ordering::Release);
                    push_log(
                        &inner,
                        &format!("Could not monitor llama-server process: {error}"),
                    );
                    if let Err(cleanup_error) = terminate_child_and_reap(&mut process.child) {
                        push_log(
                            &inner,
                            &format!("Could not terminate llama-server process: {cleanup_error}"),
                        );
                    }
                    let logs = recent_logs(&inner);
                    if let Ok(mut current_port) = inner.port.lock() {
                        *current_port = None;
                    }
                    push_state_for_session(
                        &inner,
                        session_id,
                        RuntimeState::Failed {
                            exit_code: None,
                            last_lines: logs,
                        },
                        true,
                    );
                    drop(process);
                    return;
                }
                Ok(None) => {}
            }

            drop(running);
            if !ready {
                if matches!(
                    loopback_status(port, "/health", Duration::from_millis(800)),
                    Ok(200)
                ) {
                    let running = match inner.running.lock() {
                        Ok(running) => running,
                        Err(_) => return,
                    };
                    let Some(process) = running.as_ref() else {
                        return;
                    };
                    if process.session_id != session_id
                        || process.cancel_monitor.load(Ordering::Acquire)
                        || cancel_monitor.load(Ordering::Acquire)
                        || !push_state_for_session(&inner, session_id, RuntimeState::Ready, false)
                    {
                        return;
                    }
                    ready = true;
                }

                if !ready && Instant::now() >= deadline {
                    let mut running = match inner.running.lock() {
                        Ok(running) => running,
                        Err(_) => return,
                    };
                    let Some(process) = running.as_ref() else {
                        return;
                    };
                    if process.session_id != session_id
                        || process.cancel_monitor.load(Ordering::Acquire)
                        || cancel_monitor.load(Ordering::Acquire)
                    {
                        return;
                    }
                    let Some(mut process) = running.take() else {
                        return;
                    };
                    process.cancel_monitor.store(true, Ordering::Release);
                    if let Err(error) = terminate_child_and_reap(&mut process.child) {
                        push_log(
                            &inner,
                            &format!("Could not terminate llama-server: {error}"),
                        );
                    }
                    let logs = recent_logs(&inner);
                    if let Ok(mut current_port) = inner.port.lock() {
                        *current_port = None;
                    }
                    push_state_for_session(
                        &inner,
                        session_id,
                        RuntimeState::Failed {
                            exit_code: None,
                            last_lines: logs,
                        },
                        true,
                    );
                    drop(process);
                    return;
                }
            }
        }
    });
}

fn recent_logs(inner: &SupervisorInner) -> Vec<String> {
    inner
        .logs
        .lock()
        .map(|guard| guard.iter().rev().take(20).rev().cloned().collect())
        .unwrap_or_default()
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

    #[test]
    fn failed_state_serializes_camel_case_fields() {
        let state = RuntimeState::Failed {
            exit_code: Some(23),
            last_lines: vec!["server exited".into()],
        };

        assert_eq!(
            serde_json::to_value(state).expect("serialize failed state"),
            serde_json::json!({
                "kind": "failed",
                "exitCode": 23,
                "lastLines": ["server exited"]
            })
        );
    }

    #[test]
    fn stale_session_cannot_change_replacement_state() {
        let mut state = SupervisorState::new();
        state.start_session(1);
        state.set_unowned(RuntimeState::Stopped);
        state.start_session(2);

        assert!(!state.update_session(
            1,
            RuntimeState::Failed {
                exit_code: Some(1),
                last_lines: vec![],
            },
            true,
        ));
        assert!(matches!(state.state, RuntimeState::Starting));
        assert_eq!(state.session_id, Some(2));
    }

    #[cfg(windows)]
    #[test]
    fn failed_job_setup_terminates_and_reaps_spawned_child() {
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test process");

        let message = abort_spawned_child(
            &mut child,
            "could not assign llama-server to kill switch",
            std::io::Error::other("test failure"),
        );

        assert!(message.contains("could not assign llama-server to kill switch"));
        assert!(child.try_wait().expect("wait for child").is_some());
    }
}
