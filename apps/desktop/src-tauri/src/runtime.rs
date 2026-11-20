use aangan_net::{DlState, DownloadSpec, NetGate, Progress, Purpose, download::download};
use aangan_runtime::{
    extract::{RUNTIME_LIMITS, extract_zip_safely},
    manifest::{self, RuntimeEntry, RuntimeManifest, RuntimeVariant},
    variant::{HwFacts, Kind, pick_variant},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::catalog::signature::{CATALOG_PUBLIC_KEYS, verify_catalog};

const RUNTIME_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/panthak4tech/aangan/main/catalog/runtimes.v1.json";
const MAX_SIGNATURE_BYTES: usize = 4 * 1024;
const RUNTIME_CACHE_FILE: &str = "runtime-manifest-cache.v1.json";
const RUNTIME_SETTINGS_FILE: &str = "runtime-settings.json";
const INSTALL_RECORD_FILE: &str = "aangan-runtime.json";
const SMOKE_TEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SignedRuntimeCache {
    manifest_json: Vec<u8>,
    signature: String,
}

fn trusted_runtime_root(data_dir: &Path) -> Result<Option<PathBuf>, String> {
    let canonical_data_dir = fs::canonicalize(data_dir)
        .map_err(|error| format!("could not resolve app data folder: {error}"))?;
    let root = canonical_data_dir.join("runtimes");
    match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("runtime folder is not a regular directory".into())
        }
        Ok(_) => {
            let canonical = fs::canonicalize(&root)
                .map_err(|error| format!("could not resolve runtime folder: {error}"))?;
            if canonical != canonical_data_dir.join("runtimes") {
                return Err("runtime folder resolves outside the application data folder".into());
            }
            Ok(Some(canonical))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("could not inspect runtime folder: {error}")),
    }
}

async fn ensure_runtime_folder(data_dir: &Path, components: &[&str]) -> Result<PathBuf, String> {
    let canonical_data_dir = tokio::fs::canonicalize(data_dir)
        .await
        .map_err(|error| format!("could not resolve app data folder: {error}"))?;
    let root = canonical_data_dir.join("runtimes");
    let mut current = root.clone();
    ensure_directory_component(&canonical_data_dir, &mut current).await?;
    for component in components {
        if !is_safe_component(component) {
            return Err("runtime path components are invalid".into());
        }
        current.push(component);
        ensure_directory_component(&canonical_data_dir, &mut current).await?;
    }
    Ok(current)
}

async fn ensure_directory_component(
    canonical_data_dir: &Path,
    path: &mut PathBuf,
) -> Result<(), String> {
    match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("runtime path is not a regular directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir(&path)
                .await
                .map_err(|error| format!("could not create runtime folder: {error}"))?;
        }
        Err(error) => return Err(format!("could not inspect runtime folder: {error}")),
    }
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|error| format!("could not resolve runtime folder: {error}"))?;
    if !canonical.starts_with(canonical_data_dir) {
        return Err("runtime folder resolves outside the application data folder".into());
    }
    *path = canonical;
    Ok(())
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct RuntimeSettings {
    default_runtime: Option<InstalledRuntimeKey>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntimeKey {
    runtime_id: String,
    version: String,
    variant: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInstallRecord {
    schema: u32,
    runtime_id: String,
    version: String,
    variant: String,
    server_exe: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCatalog {
    pub generated_at: String,
    pub signature_verified: bool,
    pub warning: Option<String>,
    pub default_runtime: Option<InstalledRuntimeKey>,
    pub runtimes: Vec<RuntimeCard>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCard {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub license: String,
    pub homepage: String,
    pub recommended_variant: Option<String>,
    pub recommendation_reason: String,
    pub variants: Vec<RuntimeVariantCard>,
    pub installed: Vec<InstalledRuntime>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVariantCard {
    pub variant: String,
    pub kind: Kind,
    pub requires_cuda_driver: Option<u32>,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntime {
    pub runtime_id: String,
    pub version: String,
    pub variant: String,
    pub path: String,
    pub size_bytes: u64,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStorageEntry {
    pub runtime_id: String,
    pub version: String,
    pub variant: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallResult {
    pub runtime_id: String,
    pub version: String,
    pub variant: String,
    pub path: String,
}

struct LoadedManifest {
    manifest: RuntimeManifest,
    signature_verified: bool,
    warning: Option<String>,
}

pub fn list(data_dir: &Path, bundled_json: &str) -> Result<RuntimeCatalog, String> {
    let loaded = load_manifest(data_dir, bundled_json)?;
    let settings = load_settings(data_dir)?;
    let hardware = hwprobe::runtime_facts();
    let hw = HwFacts {
        nvidia_cuda_driver: hardware.nvidia_cuda_driver,
        has_discrete_gpu: hardware.has_discrete_gpu,
    };
    let installed = installed_runtimes(data_dir, settings.default_runtime.as_ref())?;
    let runtimes = loaded
        .manifest
        .runtimes
        .iter()
        .map(|runtime| runtime_card(runtime, &hw, &installed))
        .collect();
    Ok(RuntimeCatalog {
        generated_at: loaded.manifest.generated_at,
        signature_verified: loaded.signature_verified,
        warning: loaded.warning,
        default_runtime: settings.default_runtime,
        runtimes,
    })
}

pub async fn check_updates(
    gate: &Arc<NetGate>,
    data_dir: &Path,
    bundled_json: &str,
) -> Result<RuntimeCatalog, String> {
    if gate.is_offline() {
        return Err("Offline mode is on. Turn it off to check for runtime updates.".into());
    }
    let existing = load_manifest(data_dir, bundled_json)?;
    let url = Url::parse(RUNTIME_MANIFEST_URL)
        .map_err(|error| format!("runtime manifest URL is invalid: {error}"))?;
    if !is_runtime_manifest_url(&url) {
        return Err("runtime manifest URL is not allow-listed".into());
    }
    let mut signature_url = url.clone();
    signature_url.set_path(&format!("{}.minisig", url.path()));
    let bytes = fetch_limited(gate, &url, manifest::MAX_MANIFEST_BYTES, "runtime manifest").await?;
    let signature_bytes = fetch_limited(
        gate,
        &signature_url,
        MAX_SIGNATURE_BYTES,
        "runtime manifest signature",
    )
    .await?;
    let signature = std::str::from_utf8(&signature_bytes)
        .map_err(|_| "runtime manifest signature is malformed".to_string())?;
    verify_catalog(&bytes, signature, CATALOG_PUBLIC_KEYS)
        .map_err(|error| format!("runtime manifest signature is invalid: {error}"))?;
    let updated = parse_manifest(&bytes)?;
    if updated.generated_at <= existing.manifest.generated_at {
        return Err("No newer runtime manifest is available.".into());
    }
    let cache = SignedRuntimeCache {
        manifest_json: bytes,
        signature: signature.to_string(),
    };
    let encoded = serde_json::to_vec(&cache)
        .map_err(|error| format!("could not encode runtime manifest cache: {error}"))?;
    write_atomic(
        &data_dir.join(RUNTIME_CACHE_FILE),
        &encoded,
        "runtime manifest cache",
    )?;
    list(data_dir, bundled_json)
}

pub async fn install(
    app: &tauri::AppHandle,
    gate: &Arc<NetGate>,
    data_dir: &Path,
    bundled_json: &str,
    runtime_id: &str,
    variant_name: &str,
) -> Result<RuntimeInstallResult, String> {
    if gate.is_offline() {
        return Err("Offline mode is on. Turn it off to install a runtime.".into());
    }
    let loaded = load_manifest(data_dir, bundled_json)?;
    let runtime = loaded
        .manifest
        .runtimes
        .iter()
        .find(|runtime| runtime.id == runtime_id)
        .ok_or_else(|| format!("runtime is not in the signed manifest: {runtime_id}"))?;
    let variant = runtime
        .variants
        .iter()
        .find(|variant| variant.meta.variant == variant_name)
        .ok_or_else(|| format!("variant is not available: {variant_name}"))?;
    install_variant(app, gate, data_dir, runtime, variant).await
}

pub fn remove(
    data_dir: &Path,
    runtime_id: &str,
    version: &str,
    variant: &str,
) -> Result<(), String> {
    if !is_safe_component(runtime_id) || !is_safe_component(version) || !is_safe_component(variant)
    {
        return Err("runtime path components are invalid".into());
    }
    if runtime_id == "_downloads" {
        return Err("runtime path components are invalid".into());
    }
    let canonical_data_dir = fs::canonicalize(data_dir)
        .map_err(|error| format!("could not resolve app data folder: {error}"))?;
    let runtime_root = canonical_data_dir.join("runtimes");
    let runtime_dir = runtime_root.join(runtime_id);
    let target = runtime_dir.join(format!("{version}-{variant}"));
    for path in [&runtime_root, &runtime_dir] {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("runtime path is not a regular directory".into());
            }
            Ok(_) => {}
            Err(error) => return Err(format!("could not inspect runtime folder: {error}")),
        }
    }
    let metadata = fs::symlink_metadata(&target)
        .map_err(|error| format!("could not inspect installed runtime: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("installed runtime is not a regular directory".into());
    }
    let canonical_root = fs::canonicalize(&runtime_root)
        .map_err(|error| format!("could not resolve runtime folder: {error}"))?;
    let canonical_runtime_dir = fs::canonicalize(&runtime_dir)
        .map_err(|error| format!("could not resolve runtime id folder: {error}"))?;
    let canonical_target = fs::canonicalize(&target)
        .map_err(|error| format!("could not resolve installed runtime: {error}"))?;
    if canonical_root != canonical_data_dir.join("runtimes")
        || !canonical_runtime_dir.starts_with(&canonical_root)
        || canonical_target.parent() != Some(canonical_runtime_dir.as_path())
    {
        return Err("installed runtime resolves outside the runtimes folder".into());
    }
    fs::remove_dir_all(&canonical_target)
        .map_err(|error| format!("could not remove installed runtime: {error}"))?;
    let mut settings = load_settings(data_dir)?;
    if settings.default_runtime.as_ref()
        == Some(&InstalledRuntimeKey {
            runtime_id: runtime_id.to_string(),
            version: version.to_string(),
            variant: variant.to_string(),
        })
    {
        settings.default_runtime = None;
        save_settings(data_dir, &settings)?;
    }
    Ok(())
}

pub fn set_default(
    data_dir: &Path,
    runtime_id: &str,
    version: &str,
    variant: &str,
) -> Result<(), String> {
    let key = InstalledRuntimeKey {
        runtime_id: runtime_id.to_string(),
        version: version.to_string(),
        variant: variant.to_string(),
    };
    if !installed_runtimes(data_dir, None)?.iter().any(|runtime| {
        runtime.runtime_id == key.runtime_id
            && runtime.version == key.version
            && runtime.variant == key.variant
    }) {
        return Err("the selected runtime is not installed".into());
    }
    let mut settings = load_settings(data_dir)?;
    settings.default_runtime = Some(key);
    save_settings(data_dir, &settings)
}

pub fn storage_entries(data_dir: &Path) -> Result<Vec<RuntimeStorageEntry>, String> {
    installed_runtimes(data_dir, None).map(|items| {
        items
            .into_iter()
            .map(|item| RuntimeStorageEntry {
                runtime_id: item.runtime_id,
                version: item.version,
                variant: item.variant,
                path: item.path,
                size_bytes: item.size_bytes,
            })
            .collect()
    })
}

pub fn cleanup_stale_tmp(data_dir: &Path) -> Result<(), String> {
    let root = match trusted_runtime_root(data_dir)? {
        Some(root) => root,
        None => return Ok(()),
    };
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("could not list runtime folders: {error}")),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("could not read runtime folder entry: {error}"))?;
        let metadata = entry
            .file_type()
            .map_err(|error| format!("could not inspect runtime folder: {error}"))?;
        if metadata.is_symlink() || !metadata.is_dir() {
            continue;
        }
        let children = fs::read_dir(entry.path())
            .map_err(|error| format!("could not list runtime versions: {error}"))?;
        for child in children {
            let child =
                child.map_err(|error| format!("could not read runtime version entry: {error}"))?;
            let name = child.file_name();
            if !name.to_string_lossy().ends_with(".tmp") {
                continue;
            }
            let metadata = child
                .file_type()
                .map_err(|error| format!("could not inspect temporary runtime: {error}"))?;
            if metadata.is_symlink() || !metadata.is_dir() {
                continue;
            }
            fs::remove_dir_all(child.path())
                .map_err(|error| format!("could not remove stale runtime folder: {error}"))?;
        }
    }
    Ok(())
}

fn runtime_card(
    runtime: &RuntimeEntry,
    hardware: &HwFacts,
    all_installed: &[InstalledRuntime],
) -> RuntimeCard {
    let offered = runtime
        .variants
        .iter()
        .map(|variant| variant.meta.clone())
        .collect::<Vec<_>>();
    let recommended = pick_variant(&offered, hardware);
    let recommendation_reason = match recommended.map(|variant| variant.kind) {
        Some(Kind::Cuda) => "Your NVIDIA driver supports this CUDA build.",
        Some(Kind::Vulkan) => "A discrete GPU is available; CUDA is unavailable or unsupported.",
        _ => "CPU is the compatible fallback for this PC.",
    }
    .to_string();
    RuntimeCard {
        id: runtime.id.clone(),
        display_name: runtime.display_name.clone(),
        version: runtime.version.clone(),
        license: runtime.license.clone(),
        homepage: runtime.homepage.clone(),
        recommended_variant: recommended.map(|variant| variant.variant.clone()),
        recommendation_reason,
        variants: runtime
            .variants
            .iter()
            .map(|variant| RuntimeVariantCard {
                variant: variant.meta.variant.clone(),
                kind: variant.meta.kind,
                requires_cuda_driver: variant.meta.requires_cuda_driver,
                size_bytes: variant.files.iter().map(|file| file.size_bytes).sum(),
            })
            .collect(),
        installed: all_installed
            .iter()
            .filter(|installed| installed.runtime_id == runtime.id)
            .cloned()
            .collect(),
    }
}

async fn install_variant(
    app: &tauri::AppHandle,
    gate: &Arc<NetGate>,
    data_dir: &Path,
    runtime: &RuntimeEntry,
    variant: &RuntimeVariant,
) -> Result<RuntimeInstallResult, String> {
    let downloads_dir = ensure_runtime_folder(
        data_dir,
        &["_downloads", &runtime.id, &variant.meta.variant],
    )
    .await?;
    let mut archives = Vec::with_capacity(variant.files.len());
    let total_size = variant
        .files
        .iter()
        .fold(0_u64, |sum, file| sum.saturating_add(file.size_bytes));
    for (index, file) in variant.files.iter().enumerate() {
        let url = Url::parse(&file.url)
            .map_err(|error| format!("runtime download URL is invalid: {error}"))?;
        let filename = url
            .path_segments()
            .and_then(Iterator::last)
            .filter(|name| is_safe_component(name))
            .ok_or_else(|| "runtime download filename is invalid".to_string())?;
        let destination = downloads_dir.join(filename);
        let spec = DownloadSpec {
            id: format!("runtime-{}-{}-{index}", runtime.id, variant.meta.variant),
            url: file.url.clone(),
            dest: destination.clone(),
            sha256: file.sha256.clone(),
            size: file.size_bytes,
            purpose: Purpose::RuntimeDownload,
        };
        let completed_bytes = variant.files[..index].iter().fold(0_u64, |sum, previous| {
            sum.saturating_add(previous.size_bytes)
        });
        let app_handle = app.clone();
        let downloaded = match download(gate, &spec, &CancellationToken::new(), move |progress| {
            let mut progress = progress;
            progress.done = completed_bytes.saturating_add(progress.done);
            progress.total = total_size;
            if progress.state == DlState::Done {
                progress.state = DlState::Downloading;
            }
            if let Err(error) = app_handle.emit("runtimes://progress", progress) {
                eprintln!("could not emit runtime progress: {error}");
            }
        })
        .await
        {
            Ok(path) => path,
            Err(error) => {
                let message = error.to_string();
                emit_progress(
                    app,
                    Progress {
                        id: format!("runtime-{}-{}", runtime.id, variant.meta.variant),
                        state: DlState::Failed(message.clone()),
                        done: 0,
                        total: total_size,
                        bytes_per_sec: 0,
                        eta_secs: None,
                    },
                );
                return Err(message);
            }
        };
        archives.push(downloaded);
    }

    let runtime_dir = ensure_runtime_folder(data_dir, &[&runtime.id]).await?;
    let folder_name = format!("{}-{}", runtime.version, variant.meta.variant);
    let temporary = runtime_dir.join(format!("{folder_name}.tmp"));
    let final_path = runtime_dir.join(&folder_name);
    if path_exists(&temporary).await? || path_exists(&final_path).await? {
        return Err("this runtime version or a temporary install already exists".into());
    }

    emit_progress(
        app,
        Progress {
            id: format!("runtime-{}-{}", runtime.id, variant.meta.variant),
            state: DlState::Verifying,
            done: total_size,
            total: total_size,
            bytes_per_sec: 0,
            eta_secs: None,
        },
    );
    tokio::fs::create_dir(&temporary)
        .await
        .map_err(|error| format!("could not create temporary runtime folder: {error}"))?;
    let extraction = async {
        for archive in &archives {
            let archive = archive.clone();
            let destination = temporary.clone();
            tokio::task::spawn_blocking(move || {
                extract_zip_safely(&archive, &destination, &RUNTIME_LIMITS)
            })
            .await
            .map_err(|error| format!("runtime extraction task failed: {error}"))??;
        }
        let executable = safe_runtime_file(&temporary, &variant.server_exe)?;
        let smoke_path = executable.clone();
        tokio::task::spawn_blocking(move || smoke_test(&smoke_path))
            .await
            .map_err(|error| format!("runtime smoke test task failed: {error}"))??;
        let record = RuntimeInstallRecord {
            schema: 1,
            runtime_id: runtime.id.clone(),
            version: runtime.version.clone(),
            variant: variant.meta.variant.clone(),
            server_exe: variant.server_exe.clone(),
        };
        let record_bytes = serde_json::to_vec(&record)
            .map_err(|error| format!("could not encode runtime install record: {error}"))?;
        tokio::fs::write(temporary.join(INSTALL_RECORD_FILE), record_bytes)
            .await
            .map_err(|error| format!("could not write runtime install record: {error}"))?;
        tokio::fs::rename(&temporary, &final_path)
            .await
            .map_err(|error| format!("could not finish runtime installation: {error}"))?;
        Ok::<(), String>(())
    }
    .await;

    if let Err(error) = extraction {
        match tokio::fs::remove_dir_all(&temporary).await {
            Ok(()) => {}
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {}
            Err(cleanup_error) => {
                return Err(format!(
                    "{error}; temporary runtime cleanup failed: {cleanup_error}"
                ));
            }
        }
        emit_progress(
            app,
            Progress {
                id: format!("runtime-{}-{}", runtime.id, variant.meta.variant),
                state: DlState::Failed(error.clone()),
                done: total_size,
                total: total_size,
                bytes_per_sec: 0,
                eta_secs: None,
            },
        );
        return Err(error);
    }

    for archive in archives {
        tokio::fs::remove_file(&archive).await.map_err(|error| {
            format!("runtime installed, but could not remove download archive: {error}")
        })?;
    }
    let installed = RuntimeInstallResult {
        runtime_id: runtime.id.clone(),
        version: runtime.version.clone(),
        variant: variant.meta.variant.clone(),
        path: final_path.to_string_lossy().into_owned(),
    };
    emit_progress(
        app,
        Progress {
            id: format!("runtime-{}-{}", runtime.id, variant.meta.variant),
            state: DlState::Done,
            done: total_size,
            total: total_size,
            bytes_per_sec: 0,
            eta_secs: None,
        },
    );
    Ok(installed)
}

fn emit_progress(app: &tauri::AppHandle, progress: Progress) {
    if let Err(error) = app.emit("runtimes://progress", progress) {
        eprintln!("could not emit runtime progress: {error}");
    }
}

fn safe_runtime_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative.is_empty()
        || relative.contains(['\\', ':'])
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("runtime server executable path is unsafe".into());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("could not resolve temporary runtime folder: {error}"))?;
    let file = root.join(relative_path);
    let metadata = fs::symlink_metadata(&file)
        .map_err(|error| format!("runtime server executable is missing: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("runtime server executable is not a regular file".into());
    }
    let canonical = fs::canonicalize(&file)
        .map_err(|error| format!("could not resolve runtime server executable: {error}"))?;
    if !canonical.starts_with(&root) {
        return Err("runtime server executable resolves outside the install folder".into());
    }
    Ok(canonical)
}

fn smoke_test(executable: &Path) -> Result<(), String> {
    let mut command = Command::new(executable);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not run llama-server.exe --version: {error}"))?;
    let deadline = Instant::now() + SMOKE_TEST_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(if status.code() == Some(0xC0000135_u32 as i32) {
                    "A Windows component is missing. Install the Microsoft Visual C++ Redistributable (x64) and try again.".into()
                } else {
                    format!("llama-server.exe --version exited with {status}")
                });
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => {
                stop_smoke_child(&mut child).map_err(|error| {
                    format!("runtime smoke test timed out and could not be stopped: {error}")
                })?;
                return Err("llama-server.exe --version timed out after 15 seconds".into());
            }
            Err(error) => {
                let message = format!("could not wait for runtime smoke test: {error}");
                return match stop_smoke_child(&mut child) {
                    Ok(()) => Err(message),
                    Err(stop_error) => Err(format!(
                        "{message}; could not stop child process: {stop_error}"
                    )),
                };
            }
        }
    }
}

fn stop_smoke_child(child: &mut Child) -> Result<(), String> {
    if let Err(kill_error) = child.kill() {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => return Err(format!("could not kill child process: {kill_error}")),
            Err(wait_error) => {
                return Err(format!(
                    "could not kill child process: {kill_error}; could not inspect process state: {wait_error}"
                ));
            }
        }
    }
    child
        .wait()
        .map(|_| ())
        .map_err(|error| format!("could not reap child process: {error}"))
}

async fn path_exists(path: &Path) -> Result<bool, String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("could not inspect runtime path: {error}")),
    }
}

fn load_manifest(data_dir: &Path, bundled_json: &str) -> Result<LoadedManifest, String> {
    let bundled = parse_manifest(bundled_json.as_bytes())
        .map_err(|error| format!("bundled runtime manifest is invalid: {error}"))?;
    let path = data_dir.join(RUNTIME_CACHE_FILE);
    match fs::read(&path) {
        Ok(bytes) => {
            let cache: SignedRuntimeCache = match serde_json::from_slice(&bytes) {
                Ok(cache) => cache,
                Err(error) => {
                    return Ok(discard_invalid_cache(
                        &path,
                        bundled,
                        format!("cached runtime manifest data is invalid: {error}"),
                    ));
                }
            };
            if let Err(error) =
                verify_catalog(&cache.manifest_json, &cache.signature, CATALOG_PUBLIC_KEYS)
            {
                return Ok(discard_invalid_cache(
                    &path,
                    bundled,
                    format!("cached runtime manifest signature is invalid: {error}"),
                ));
            }
            match parse_manifest(&cache.manifest_json) {
                Ok(cached) if cached.generated_at > bundled.generated_at => Ok(LoadedManifest {
                    manifest: cached,
                    signature_verified: true,
                    warning: None,
                }),
                Ok(_) => Ok(LoadedManifest {
                    manifest: bundled,
                    signature_verified: false,
                    warning: None,
                }),
                Err(error) => Ok(discard_invalid_cache(
                    &path,
                    bundled,
                    format!("cached runtime manifest is invalid: {error}"),
                )),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LoadedManifest {
            manifest: bundled,
            signature_verified: false,
            warning: None,
        }),
        Err(error) => Ok(LoadedManifest {
            manifest: bundled,
            signature_verified: false,
            warning: Some(format!(
                "Cached runtime manifest could not be read; using the bundled manifest. {error}"
            )),
        }),
    }
}

fn discard_invalid_cache(path: &Path, bundled: RuntimeManifest, reason: String) -> LoadedManifest {
    let warning = match fs::remove_file(path) {
        Ok(()) => {
            format!("Cached runtime manifest was rejected; using the bundled manifest. {reason}")
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            format!("Cached runtime manifest was rejected; using the bundled manifest. {reason}")
        }
        Err(error) => format!(
            "Cached runtime manifest was rejected; using the bundled manifest. {reason} Cache removal failed: {error}"
        ),
    };
    eprintln!("{warning}");
    LoadedManifest {
        manifest: bundled,
        signature_verified: false,
        warning: Some(warning),
    }
}

fn parse_manifest(bytes: &[u8]) -> Result<RuntimeManifest, String> {
    if bytes.len() > manifest::MAX_MANIFEST_BYTES {
        return Err("runtime manifest exceeds the 1 MiB limit".into());
    }
    let runtime_manifest: RuntimeManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("runtime manifest JSON is invalid: {error}"))?;
    manifest::validate(&runtime_manifest)?;
    Ok(runtime_manifest)
}

fn is_runtime_manifest_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("raw.githubusercontent.com")
        && url.path() == "/panthak4tech/aangan/main/catalog/runtimes.v1.json"
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

async fn fetch_limited(
    gate: &Arc<NetGate>,
    url: &Url,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut response = gate
        .get(Purpose::RuntimeManifest, url.as_str(), None)
        .await
        .map_err(|error| format!("could not download {label}: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        response
            .finish(false, &format!("HTTP {status}"))
            .map_err(|error| error.to_string())?;
        return Err(format!(
            "{label} server returned an unexpected status: {status}"
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        response
            .finish(false, "exceeds the size limit")
            .map_err(|error| error.to_string())?;
        return Err(format!("{label} exceeds the size limit"));
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                let message = format!("could not read {label} response: {error}");
                response
                    .finish(false, &message)
                    .map_err(|finish_error| finish_error.to_string())?;
                return Err(message);
            }
        };
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            response
                .finish(false, "exceeds the size limit")
                .map_err(|error| error.to_string())?;
            return Err(format!("{label} exceeds the size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    response
        .finish(true, "ok")
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn load_settings(data_dir: &Path) -> Result<RuntimeSettings, String> {
    match fs::read(data_dir.join(RUNTIME_SETTINGS_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("runtime settings are invalid: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(RuntimeSettings::default())
        }
        Err(error) => Err(format!("could not read runtime settings: {error}")),
    }
}

fn save_settings(data_dir: &Path, settings: &RuntimeSettings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("could not encode runtime settings: {error}"))?;
    write_atomic(
        &data_dir.join(RUNTIME_SETTINGS_FILE),
        &bytes,
        "runtime settings",
    )
}

fn installed_runtimes(
    data_dir: &Path,
    default_runtime: Option<&InstalledRuntimeKey>,
) -> Result<Vec<InstalledRuntime>, String> {
    let root = match trusted_runtime_root(data_dir)? {
        Some(root) => root,
        None => return Ok(Vec::new()),
    };
    let runtime_dirs = fs::read_dir(&root)
        .map_err(|error| format!("could not list installed runtimes: {error}"))?;
    let mut installed = Vec::new();
    for runtime_dir in runtime_dirs {
        let runtime_dir =
            runtime_dir.map_err(|error| format!("could not read a runtime folder: {error}"))?;
        let metadata = runtime_dir
            .file_type()
            .map_err(|error| format!("could not inspect a runtime folder: {error}"))?;
        if metadata.is_symlink() || !metadata.is_dir() || runtime_dir.file_name() == "_downloads" {
            continue;
        }
        let versions = fs::read_dir(runtime_dir.path())
            .map_err(|error| format!("could not list runtime versions: {error}"))?;
        for version_dir in versions {
            let version_dir = version_dir
                .map_err(|error| format!("could not read a runtime version folder: {error}"))?;
            let metadata = version_dir
                .file_type()
                .map_err(|error| format!("could not inspect a runtime version folder: {error}"))?;
            if metadata.is_symlink() || !metadata.is_dir() {
                continue;
            }
            let record_path = version_dir.path().join(INSTALL_RECORD_FILE);
            let record_bytes = match fs::read(&record_path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!("could not read runtime install record: {error}"));
                }
            };
            let record: RuntimeInstallRecord = serde_json::from_slice(&record_bytes)
                .map_err(|error| format!("runtime install record is invalid: {error}"))?;
            if record.schema != 1
                || !is_safe_component(&record.runtime_id)
                || !is_safe_component(&record.version)
                || !is_safe_component(&record.variant)
                || record.runtime_id != runtime_dir.file_name().to_string_lossy()
            {
                return Err("runtime install record contains invalid path components".into());
            }
            installed.push(InstalledRuntime {
                runtime_id: record.runtime_id.clone(),
                version: record.version.clone(),
                variant: record.variant.clone(),
                path: version_dir.path().to_string_lossy().into_owned(),
                size_bytes: directory_size(&version_dir.path())?,
                is_default: default_runtime.is_some_and(|key| {
                    key.runtime_id == record.runtime_id
                        && key.version == record.version
                        && key.variant == record.variant
                }),
            });
        }
    }
    installed.sort_by(|left, right| {
        (&left.runtime_id, &left.version, &left.variant).cmp(&(
            &right.runtime_id,
            &right.version,
            &right.variant,
        ))
    });
    Ok(installed)
}

fn directory_size(path: &Path) -> Result<u64, String> {
    let entries = fs::read_dir(path)
        .map_err(|error| format!("could not list runtime install folder: {error}"))?;
    let mut total = 0_u64;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("could not read runtime install entry: {error}"))?;
        let metadata = entry
            .file_type()
            .map_err(|error| format!("could not inspect runtime install entry: {error}"))?;
        if metadata.is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            total = total.saturating_add(directory_size(&entry.path())?);
        } else if metadata.is_file() {
            total = total.saturating_add(
                entry
                    .metadata()
                    .map_err(|error| format!("could not inspect runtime file size: {error}"))?
                    .len(),
            );
        }
    }
    Ok(total)
}

fn is_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn write_atomic(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("could not determine the {label} directory"))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create the {label} directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("could not create a temporary {label} file: {error}"))?;
    temporary
        .write_all(bytes)
        .map_err(|error| format!("could not write {label}: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("could not flush {label}: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("could not save {label}: {}", error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_record(runtime_dir: &Path) {
        fs::create_dir_all(runtime_dir).unwrap();
        let record = RuntimeInstallRecord {
            schema: 1,
            runtime_id: "llama.cpp".into(),
            version: "b1234".into(),
            variant: "cpu".into(),
            server_exe: "llama-server.exe".into(),
        };
        fs::write(
            runtime_dir.join(INSTALL_RECORD_FILE),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn removal_only_deletes_a_runtime_inside_the_managed_root() {
        let data = tempfile::tempdir().unwrap();
        let install = data.path().join("runtimes/llama.cpp/b1234-cpu");
        install_record(&install);
        let outside = data.path().join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        set_default(data.path(), "llama.cpp", "b1234", "cpu").unwrap();

        remove(data.path(), "llama.cpp", "b1234", "cpu").unwrap();

        assert!(!install.exists());
        assert_eq!(fs::read(outside).unwrap(), b"keep");
        assert!(
            load_settings(data.path())
                .unwrap()
                .default_runtime
                .is_none()
        );
    }

    #[test]
    fn removal_rejects_traversal_components() {
        let data = tempfile::tempdir().unwrap();
        let outside = data.path().join("outside");
        fs::create_dir(&outside).unwrap();

        let error = remove(data.path(), "..", "b1234", "cpu").unwrap_err();

        assert!(error.contains("invalid"));
        assert!(outside.exists());
    }

    #[test]
    fn startup_cleanup_removes_only_stale_temporary_runtime_directories() {
        let data = tempfile::tempdir().unwrap();
        let runtime_dir = data.path().join("runtimes/llama.cpp");
        let temporary = runtime_dir.join("b1234-cpu.tmp");
        let installed = runtime_dir.join("b1234-cpu");
        fs::create_dir_all(&temporary).unwrap();
        fs::create_dir_all(&installed).unwrap();

        cleanup_stale_tmp(data.path()).unwrap();

        assert!(!temporary.exists());
        assert!(installed.exists());
    }

    #[test]
    fn server_executable_must_exist_inside_the_install_folder() {
        let directory = tempfile::tempdir().unwrap();
        let error = safe_runtime_file(directory.path(), "llama-server.exe").unwrap_err();

        assert!(error.contains("missing"));
    }

    #[test]
    fn bundled_runtime_manifest_is_valid_and_has_llama_cpp() {
        let bundled = include_str!("../../../../catalog/runtimes.v1.json");

        let manifest = parse_manifest(bundled.as_bytes()).unwrap();

        assert_eq!(manifest.runtimes.len(), 1);
        assert_eq!(manifest.runtimes[0].id, "llama.cpp");
        assert!(!manifest.runtimes[0].variants.is_empty());
    }
}
