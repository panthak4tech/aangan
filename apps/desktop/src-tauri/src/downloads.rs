use aangan_net::download::{part_path, sha256_file};
use aangan_net::{DlError, DlState, DownloadSpec, NetError, NetGate, Progress, download};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::SystemTime,
};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

type ProgressCallback = Arc<dyn Fn(Progress) + Send + Sync>;
type DownloadFuture = Pin<Box<dyn Future<Output = Result<PathBuf, DlError>> + Send>>;
type DownloadRunner =
    Arc<dyn Fn(DownloadSpec, CancellationToken, ProgressCallback) -> DownloadFuture + Send + Sync>;
type EventCallback = Arc<dyn Fn(Progress) + Send + Sync>;

#[derive(Clone)]
pub struct DownloadManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    sender: mpsc::Sender<String>,
    entries: Mutex<HashMap<String, DownloadEntry>>,
    storage_operations: Mutex<()>,
    reserved_storage_paths: Mutex<HashSet<PathBuf>>,
    on_event: EventCallback,
    offline: AtomicBool,
}

struct DownloadEntry {
    spec: DownloadSpec,
    progress: Progress,
    cancellation: CancellationToken,
    stop: Option<StopAction>,
    worker_running: bool,
    queued: bool,
    resume_when_online: bool,
    deleting: bool,
    verified_file: Option<FileFingerprint>,
    worker_finished: Arc<Notify>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileFingerprint {
    size: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume_serial_number: Option<u32>,
    #[cfg(windows)]
    file_index: Option<u64>,
}

struct RestoreInspection {
    spec: DownloadSpec,
    complete_file: Option<FileFingerprint>,
    partial_size: Option<u64>,
}

#[derive(Clone, Copy)]
enum StopAction {
    Pause,
    Cancel { delete_partial: bool },
    Offline,
}

impl DownloadManager {
    pub fn new(gate: Arc<NetGate>, on_event: impl Fn(Progress) + Send + Sync + 'static) -> Self {
        let offline = gate.is_offline();
        let runner: DownloadRunner = Arc::new(move |spec, cancellation, on_progress| {
            let gate = Arc::clone(&gate);
            Box::pin(async move {
                download(&gate, &spec, &cancellation, move |progress| {
                    on_progress(progress);
                })
                .await
            })
        });
        Self::with_runner_and_offline(runner, Arc::new(on_event), offline)
    }

    #[cfg(test)]
    fn with_runner(runner: DownloadRunner, on_event: EventCallback) -> Self {
        Self::with_runner_and_offline(runner, on_event, false)
    }

    fn with_runner_and_offline(
        runner: DownloadRunner,
        on_event: EventCallback,
        offline: bool,
    ) -> Self {
        let (sender, receiver) = mpsc::channel(64);
        let inner = Arc::new(ManagerInner {
            sender,
            entries: Mutex::new(HashMap::new()),
            storage_operations: Mutex::new(()),
            reserved_storage_paths: Mutex::new(HashSet::new()),
            on_event,
            offline: AtomicBool::new(offline),
        });
        tauri::async_runtime::spawn(run_worker(receiver, Arc::clone(&inner), runner));
        Self { inner }
    }

    pub async fn restore(&self, specs: Vec<DownloadSpec>) -> Result<(), String> {
        let inspections = tokio::task::spawn_blocking(move || inspect_restore_files(specs))
            .await
            .map_err(|error| error.to_string())??;
        for inspection in &inspections {
            let spec = &inspection.spec;
            let verified_file = match inspection.complete_file.as_ref() {
                Some(file) if file.size == spec.size => {
                    if self.has_verified_done(spec, file)? {
                        Some(file.clone())
                    } else {
                        completed_file_fingerprint(spec).await?
                    }
                }
                _ => None,
            };
            if let Some(file) = verified_file {
                self.insert_restored(spec.clone(), DlState::Done, spec.size, Some(file))?;
            } else {
                self.invalidate_done(spec)?;
            }
        }
        for inspection in inspections {
            let spec = inspection.spec;
            if self.get(&spec.id)?.is_some() {
                continue;
            }
            if let Some(size) = inspection.partial_size {
                self.insert_restored(spec, DlState::Paused, size, None)?;
            }
        }
        Ok(())
    }

    fn insert_restored(
        &self,
        spec: DownloadSpec,
        state: DlState,
        done: u64,
        verified_file: Option<FileFingerprint>,
    ) -> Result<(), String> {
        let _operation = self
            .inner
            .storage_operations
            .lock()
            .map_err(|error| format!("storage operation state is unavailable: {error}"))?;
        self.insert_restored_locked(spec, state, done, verified_file)
    }

    fn insert_restored_locked(
        &self,
        spec: DownloadSpec,
        state: DlState,
        done: u64,
        verified_file: Option<FileFingerprint>,
    ) -> Result<(), String> {
        if self.storage_path_reserved(&spec.dest)? {
            return Ok(());
        }
        let progress = Progress {
            id: spec.id.clone(),
            state,
            done,
            total: spec.size,
            bytes_per_sec: 0,
            eta_secs: None,
        };
        let mut entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        if let Some(entry) = entries.get_mut(&spec.id) {
            if entry.deleting
                || matches!(
                    entry.progress.state,
                    DlState::Queued | DlState::Downloading | DlState::Verifying
                )
            {
                return Ok(());
            }
            entry.spec = spec;
            entry.progress = progress.clone();
            entry.cancellation = CancellationToken::new();
            entry.stop = None;
            entry.queued = false;
            entry.deleting = false;
            entry.verified_file = verified_file;
        } else {
            entries.insert(
                spec.id.clone(),
                DownloadEntry {
                    spec,
                    progress: progress.clone(),
                    cancellation: CancellationToken::new(),
                    stop: None,
                    worker_running: false,
                    queued: false,
                    resume_when_online: false,
                    deleting: false,
                    verified_file,
                    worker_finished: Arc::new(Notify::new()),
                },
            );
        }
        drop(entries);
        self.publish(progress);
        Ok(())
    }

    pub async fn start(&self, spec: DownloadSpec) -> Result<Progress, String> {
        {
            let _operation = self
                .inner
                .storage_operations
                .lock()
                .map_err(|error| format!("storage operation state is unavailable: {error}"))?;
            if self.storage_path_reserved(&spec.dest)? {
                return Err("the model file is being changed in Storage".into());
            }
            match self.get(&spec.id)? {
                Some(existing)
                    if matches!(
                        existing.state,
                        DlState::Queued
                            | DlState::Downloading
                            | DlState::Verifying
                            | DlState::Paused
                            | DlState::Cancelled
                            | DlState::Failed(_)
                    ) =>
                {
                    return Ok(existing);
                }
                _ => {}
            }
        }
        let existing_done = match self.get(&spec.id)? {
            Some(existing) if existing.state == DlState::Done => self
                .get_spec(&spec.id)?
                .map(|existing_spec| (existing, existing_spec)),
            _ => None,
        };
        if let Some((existing, existing_spec)) = existing_done {
            let mut current_spec = spec.clone();
            current_spec.dest = existing_spec.dest;
            if let Some(fingerprint) = completed_file_fingerprint(&current_spec).await? {
                let _operation =
                    self.inner.storage_operations.lock().map_err(|error| {
                        format!("storage operation state is unavailable: {error}")
                    })?;
                if self.storage_path_reserved(&current_spec.dest)? {
                    return Err("the model file is being changed in Storage".into());
                }
                if current_file_fingerprint(&current_spec.dest)? == Some(fingerprint)
                    && self
                        .get(&spec.id)?
                        .is_some_and(|current| current.state == DlState::Done)
                {
                    return Ok(existing);
                }
            }
        }
        match std::fs::symlink_metadata(&spec.dest) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                if metadata.len() != spec.size {
                    return Err(format!(
                        "A file already exists at {} with a different size. Delete it from Storage before retrying.",
                        spec.dest.display()
                    ));
                }
                if let Some(verified_file) = completed_file_fingerprint(&spec).await? {
                    let _operation = self.inner.storage_operations.lock().map_err(|error| {
                        format!("storage operation state is unavailable: {error}")
                    })?;
                    if self.storage_path_reserved(&spec.dest)? {
                        return Err("the model file is being changed in Storage".into());
                    }
                    if current_file_fingerprint(&spec.dest)? != Some(verified_file.clone()) {
                        return Err(format!(
                            "The model file at {} changed while it was being verified.",
                            spec.dest.display()
                        ));
                    }
                    let progress = Progress {
                        id: spec.id.clone(),
                        state: DlState::Done,
                        done: spec.size,
                        total: spec.size,
                        bytes_per_sec: 0,
                        eta_secs: None,
                    };
                    self.insert_restored_locked(
                        spec,
                        DlState::Done,
                        progress.done,
                        Some(verified_file),
                    )?;
                    return Ok(progress);
                }
                return Err(format!(
                    "The model file at {} does not match the catalog checksum. Delete it from Storage before retrying.",
                    spec.dest.display()
                ));
            }
            Ok(_) => {
                return Err("The model destination is not a regular file.".into());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "could not inspect model destination {}: {error}",
                    spec.dest.display()
                ));
            }
        }

        let offline = self.inner.offline.load(Ordering::Acquire);
        let progress = Progress {
            id: spec.id.clone(),
            state: if offline {
                DlState::Paused
            } else {
                DlState::Queued
            },
            done: 0,
            total: spec.size,
            bytes_per_sec: 0,
            eta_secs: None,
        };
        {
            let _operation = self
                .inner
                .storage_operations
                .lock()
                .map_err(|error| format!("storage operation state is unavailable: {error}"))?;
            if self.storage_path_reserved(&spec.dest)? {
                return Err("the model file is being changed in Storage".into());
            }
            let mut entries = self
                .inner
                .entries
                .lock()
                .map_err(|error| format!("download state is unavailable: {error}"))?;
            if let Some(existing) = entries.get(&spec.id) {
                if existing.deleting {
                    return Err("the model file is being changed in Storage".into());
                }
                if matches!(
                    existing.progress.state,
                    DlState::Queued | DlState::Downloading | DlState::Verifying
                ) {
                    return Ok(existing.progress.clone());
                }
            }
            entries.insert(
                spec.id.clone(),
                DownloadEntry {
                    spec: spec.clone(),
                    progress: progress.clone(),
                    cancellation: CancellationToken::new(),
                    stop: None,
                    worker_running: false,
                    queued: !offline,
                    resume_when_online: offline,
                    deleting: false,
                    verified_file: None,
                    worker_finished: Arc::new(Notify::new()),
                },
            );
        }
        self.publish(progress.clone());
        if offline {
            return Ok(progress);
        }
        self.inner
            .sender
            .send(spec.id.clone())
            .await
            .map_err(|error| {
                let message = format!("download worker is unavailable: {error}");
                self.set_failed(&spec.id, &message);
                message
            })?;
        Ok(progress)
    }

    pub async fn pause(&self, id: &str) -> Result<Progress, String> {
        let mut publish = None;
        let progress = {
            let mut entries = self
                .inner
                .entries
                .lock()
                .map_err(|error| format!("download state is unavailable: {error}"))?;
            let entry = entries
                .get_mut(id)
                .ok_or_else(|| format!("no download exists for {id}"))?;
            if entry.deleting {
                return Err("the model file is being changed in Storage".into());
            }
            match entry.progress.state {
                DlState::Paused => return Ok(entry.progress.clone()),
                DlState::Queued | DlState::Downloading | DlState::Verifying => {}
                _ => return Err("that download cannot be paused in its current state".into()),
            }
            entry.resume_when_online = false;
            entry.stop = Some(StopAction::Pause);
            entry.cancellation.cancel();
            if entry.progress.state == DlState::Queued {
                entry.progress.state = DlState::Paused;
                publish = Some(entry.progress.clone());
            }
            entry.progress.clone()
        };
        if let Some(progress) = publish {
            self.publish(progress);
        }
        Ok(progress)
    }

    pub async fn resume(&self, id: &str) -> Result<Progress, String> {
        let (progress, enqueue) = {
            let mut entries = self
                .inner
                .entries
                .lock()
                .map_err(|error| format!("download state is unavailable: {error}"))?;
            let entry = entries
                .get_mut(id)
                .ok_or_else(|| format!("no download exists for {id}"))?;
            if entry.deleting {
                return Err("the model file is being changed in Storage".into());
            }
            if entry.progress.state == DlState::Queued && entry.queued {
                (entry.progress.clone(), false)
            } else {
                if !matches!(
                    entry.progress.state,
                    DlState::Paused | DlState::Cancelled | DlState::Failed(_)
                ) {
                    return Err("that download is not paused or failed".into());
                }
                if self.inner.offline.load(Ordering::Acquire) {
                    entry.resume_when_online = true;
                    entry.progress.state = DlState::Paused;
                    entry.progress.bytes_per_sec = 0;
                    entry.progress.eta_secs = None;
                    (entry.progress.clone(), false)
                } else if entry.worker_running {
                    entry.resume_when_online = true;
                    (entry.progress.clone(), false)
                } else {
                    entry.resume_when_online = false;
                    entry.cancellation = CancellationToken::new();
                    entry.stop = None;
                    entry.progress.state = DlState::Queued;
                    entry.progress.bytes_per_sec = 0;
                    entry.progress.eta_secs = None;
                    let enqueue = !entry.queued;
                    entry.queued = true;
                    (entry.progress.clone(), enqueue)
                }
            }
        };
        self.publish(progress.clone());
        if !enqueue {
            return Ok(progress);
        }
        self.inner
            .sender
            .send(id.to_string())
            .await
            .map_err(|error| {
                let message = format!("download worker is unavailable: {error}");
                self.set_failed(id, &message);
                message
            })?;
        Ok(progress)
    }

    pub async fn cancel(&self, id: &str, delete_partial: bool) -> Result<Progress, String> {
        let mut delete_now = None;
        let mut publish = None;
        let mut wait_for_worker = None;
        {
            let mut entries = self
                .inner
                .entries
                .lock()
                .map_err(|error| format!("download state is unavailable: {error}"))?;
            let entry = entries
                .get_mut(id)
                .ok_or_else(|| format!("no download exists for {id}"))?;
            if entry.deleting {
                return Err("the model file is being changed in Storage".into());
            }
            if entry.progress.state == DlState::Done {
                return Err("the model is already downloaded".into());
            }
            entry.stop = Some(StopAction::Cancel { delete_partial });
            entry.resume_when_online = false;
            entry.cancellation.cancel();
            if delete_partial && entry.worker_running {
                wait_for_worker = Some(Arc::clone(&entry.worker_finished));
            } else {
                entry.progress.state = DlState::Cancelled;
                entry.progress.bytes_per_sec = 0;
                entry.progress.eta_secs = None;
                if delete_partial {
                    entry.progress.done = 0;
                    delete_now = Some(part_path(&entry.spec.dest));
                }
                publish = Some(entry.progress.clone());
            }
        };
        let delete_result = match delete_now {
            Some(path) => remove_partial(&path).await,
            None => Ok(()),
        };
        if let Err(error) = delete_result {
            self.set_failed(id, &error);
            return Err(error);
        }
        if let Some(progress) = publish {
            self.publish(progress.clone());
        }
        if let Some(notify) = wait_for_worker {
            loop {
                let notified = notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if !self.is_worker_running(id)? {
                    break;
                }
                notified.await;
            }
            let progress = self
                .get(id)?
                .ok_or_else(|| format!("no download exists for {id}"))?;
            if let DlState::Failed(message) = &progress.state {
                return Err(message.clone());
            }
            return Ok(progress);
        }
        self.get(id)?
            .ok_or_else(|| format!("no download exists for {id}"))
    }

    pub async fn set_offline(&self, offline: bool) -> Result<(), String> {
        let mut published = Vec::new();
        let mut resume_ids = Vec::new();
        {
            let mut entries = self
                .inner
                .entries
                .lock()
                .map_err(|error| format!("download state is unavailable: {error}"))?;
            self.inner.offline.store(offline, Ordering::Release);
            for (id, entry) in entries.iter_mut() {
                if offline {
                    match entry.progress.state {
                        DlState::Queued => {
                            entry.resume_when_online = true;
                            entry.cancellation.cancel();
                            entry.progress.state = DlState::Paused;
                            entry.progress.bytes_per_sec = 0;
                            entry.progress.eta_secs = None;
                            published.push(entry.progress.clone());
                        }
                        DlState::Downloading | DlState::Verifying
                            if !matches!(
                                entry.stop,
                                Some(StopAction::Pause | StopAction::Cancel { .. })
                            ) =>
                        {
                            entry.resume_when_online = true;
                            entry.stop = Some(StopAction::Offline);
                            entry.cancellation.cancel();
                        }
                        _ => {}
                    }
                } else if entry.resume_when_online
                    && !entry.worker_running
                    && entry.progress.state == DlState::Paused
                {
                    resume_ids.push(id.clone());
                }
            }
        }
        for progress in published {
            self.publish(progress);
        }
        for id in resume_ids {
            self.resume(&id).await?;
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Progress>, String> {
        let entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        let mut list = entries
            .values()
            .map(|entry| entry.progress.clone())
            .collect::<Vec<_>>();
        list.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(list)
    }

    pub fn get(&self, id: &str) -> Result<Option<Progress>, String> {
        let entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        Ok(entries.get(id).map(|entry| entry.progress.clone()))
    }

    fn is_worker_running(&self, id: &str) -> Result<bool, String> {
        let entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        Ok(entries.get(id).is_some_and(|entry| entry.worker_running))
    }

    pub fn forget(&self, id: &str) -> Result<(), String> {
        let mut entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        if let Some(entry) = entries.get(id) {
            if entry.deleting {
                return Err("the model file is being changed in Storage".into());
            }
            if matches!(
                entry.progress.state,
                DlState::Queued | DlState::Downloading | DlState::Verifying
            ) {
                return Err("pause or cancel the download before deleting its file".into());
            }
        }
        entries.remove(id);
        Ok(())
    }

    pub fn reserve_storage_delete(&self, path: &Path) -> Result<Option<String>, String> {
        let _operation = self
            .inner
            .storage_operations
            .lock()
            .map_err(|error| format!("storage operation state is unavailable: {error}"))?;
        let mut reserved_paths = self
            .inner
            .reserved_storage_paths
            .lock()
            .map_err(|error| format!("storage operation state is unavailable: {error}"))?;
        if reserved_paths
            .iter()
            .any(|reserved| same_managed_path(reserved, path))
        {
            return Err("the model file is already being changed in Storage".into());
        }
        let mut entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        let matched = entries.iter_mut().find(|(_, entry)| {
            same_managed_path(&entry.spec.dest, path)
                || same_managed_path(&part_path(&entry.spec.dest), path)
        });
        let id = if let Some((id, entry)) = matched {
            if entry.deleting
                || entry.worker_running
                || matches!(
                    entry.progress.state,
                    DlState::Queued | DlState::Downloading | DlState::Verifying
                )
            {
                return Err("Pause or cancel the download before deleting its file.".into());
            }
            entry.deleting = true;
            Some(id.clone())
        } else {
            None
        };
        reserved_paths.insert(path.to_path_buf());
        Ok(id)
    }

    pub fn finish_storage_delete(
        &self,
        path: &Path,
        id: Option<&str>,
        deleted: bool,
    ) -> Result<(), String> {
        let _operation = self
            .inner
            .storage_operations
            .lock()
            .map_err(|error| format!("storage operation state is unavailable: {error}"))?;
        let mut entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        if let Some(id) = id {
            if deleted {
                entries.remove(id);
            } else if let Some(entry) = entries.get_mut(id) {
                entry.deleting = false;
            }
        }
        drop(entries);
        let mut reserved_paths = self
            .inner
            .reserved_storage_paths
            .lock()
            .map_err(|error| format!("storage operation state is unavailable: {error}"))?;
        reserved_paths.retain(|reserved| !same_managed_path(reserved, path));
        Ok(())
    }

    fn storage_path_reserved(&self, destination: &Path) -> Result<bool, String> {
        let reserved_paths = self
            .inner
            .reserved_storage_paths
            .lock()
            .map_err(|error| format!("storage operation state is unavailable: {error}"))?;
        Ok(reserved_paths.iter().any(|reserved| {
            same_managed_path(destination, reserved)
                || same_managed_path(&part_path(destination), reserved)
        }))
    }

    fn invalidate_done(&self, spec: &DownloadSpec) -> Result<(), String> {
        let mut entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        let should_remove = entries.get(&spec.id).is_some_and(|entry| {
            entry.progress.state == DlState::Done && same_path(&entry.spec.dest, &spec.dest)
        });
        if should_remove {
            entries.remove(&spec.id);
        }
        Ok(())
    }

    fn has_verified_done(
        &self,
        spec: &DownloadSpec,
        file: &FileFingerprint,
    ) -> Result<bool, String> {
        let entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        Ok(entries.get(&spec.id).is_some_and(|entry| {
            entry.progress.state == DlState::Done
                && entry.spec.size == spec.size
                && entry.spec.sha256.eq_ignore_ascii_case(&spec.sha256)
                && same_path(&entry.spec.dest, &spec.dest)
                && file.has_stable_identity()
                && entry.verified_file.as_ref() == Some(file)
        }))
    }

    fn get_spec(&self, id: &str) -> Result<Option<DownloadSpec>, String> {
        let entries = self
            .inner
            .entries
            .lock()
            .map_err(|error| format!("download state is unavailable: {error}"))?;
        Ok(entries.get(id).map(|entry| entry.spec.clone()))
    }

    fn publish(&self, progress: Progress) {
        (self.inner.on_event)(progress);
    }

    fn set_failed(&self, id: &str, message: &str) {
        let (progress, worker_finished) = match self.inner.entries.lock() {
            Ok(mut entries) => {
                let Some(entry) = entries.get_mut(id) else {
                    return;
                };
                entry.progress.state = DlState::Failed(message.to_string());
                entry.worker_running = false;
                entry.queued = false;
                entry.stop = None;
                entry.verified_file = None;
                (
                    Some(entry.progress.clone()),
                    Some(Arc::clone(&entry.worker_finished)),
                )
            }
            Err(error) => {
                eprintln!("could not update failed download state: {error}");
                (None, None)
            }
        };
        if let Some(worker_finished) = worker_finished {
            worker_finished.notify_waiters();
        }
        if let Some(progress) = progress {
            self.publish(progress);
        }
    }

    fn update_progress(&self, progress: Progress) {
        let updated = match self.inner.entries.lock() {
            Ok(mut entries) => match entries.get_mut(&progress.id) {
                Some(entry) if entry.stop.is_none() => {
                    entry.progress = progress.clone();
                    true
                }
                _ => false,
            },
            Err(error) => {
                eprintln!("could not update download progress: {error}");
                false
            }
        };
        if updated {
            self.publish(progress);
        }
    }
}

async fn run_worker(
    mut receiver: mpsc::Receiver<String>,
    inner: Arc<ManagerInner>,
    runner: DownloadRunner,
) {
    while let Some(id) = receiver.recv().await {
        let (spec, cancellation) = {
            let mut entries = match inner.entries.lock() {
                Ok(entries) => entries,
                Err(error) => {
                    eprintln!("download worker state is unavailable: {error}");
                    continue;
                }
            };
            let Some(entry) = entries.get_mut(&id) else {
                continue;
            };
            entry.queued = false;
            if entry.progress.state != DlState::Queued {
                continue;
            }
            entry.worker_running = true;
            entry.progress.state = DlState::Downloading;
            (entry.spec.clone(), entry.cancellation.clone())
        };
        let manager = DownloadManager {
            inner: Arc::clone(&inner),
        };
        match manager.get(&id) {
            Ok(Some(progress)) => manager.publish(progress),
            Ok(None) => continue,
            Err(error) => {
                eprintln!("could not read queued download state: {error}");
                continue;
            }
        }
        let callback_manager = manager.clone();
        let on_progress: ProgressCallback = Arc::new(move |progress| {
            callback_manager.update_progress(progress);
        });
        let result = runner(spec.clone(), cancellation, on_progress).await;
        let stop = match inner.entries.lock() {
            Ok(entries) => entries.get(&id).and_then(|entry| entry.stop),
            Err(error) => {
                eprintln!("could not read download stop state: {error}");
                None
            }
        };
        let offline_error = matches!(&result, Err(DlError::Net(NetError::Offline)));
        let (state, delete_partial) = match result {
            Ok(_) => (DlState::Done, false),
            Err(DlError::Cancelled) => match stop {
                Some(StopAction::Pause) => (DlState::Paused, false),
                Some(StopAction::Offline) => (DlState::Paused, false),
                Some(StopAction::Cancel { delete_partial }) => (DlState::Cancelled, delete_partial),
                None => (DlState::Cancelled, false),
            },
            Err(DlError::Net(NetError::Offline)) => match stop {
                Some(StopAction::Cancel { delete_partial }) => (DlState::Cancelled, delete_partial),
                _ => (DlState::Paused, false),
            },
            Err(error) => (DlState::Failed(error.to_string()), false),
        };
        let delete_result = if delete_partial {
            remove_partial(&part_path(&spec.dest)).await
        } else {
            Ok(())
        };
        if let Err(error) = delete_result {
            manager.set_failed(&id, &error);
            continue;
        }
        let (progress, resume_when_online, worker_finished) = match inner.entries.lock() {
            Ok(mut entries) => match entries.get_mut(&id) {
                Some(entry) => {
                    entry.progress.state = state;
                    entry.worker_running = false;
                    entry.queued = false;
                    if entry.progress.state == DlState::Done {
                        entry.verified_file = None;
                    }
                    if entry.progress.state == DlState::Paused
                        && (offline_error || matches!(stop, Some(StopAction::Offline)))
                    {
                        entry.resume_when_online = true;
                    }
                    if entry.progress.state == DlState::Done {
                        entry.progress.done = entry.progress.total;
                        entry.progress.bytes_per_sec = 0;
                        entry.progress.eta_secs = None;
                    } else if delete_partial && entry.progress.state == DlState::Cancelled {
                        entry.progress.done = 0;
                        entry.progress.bytes_per_sec = 0;
                        entry.progress.eta_secs = None;
                    }
                    entry.stop = None;
                    let should_resume = entry.resume_when_online
                        && !inner.offline.load(Ordering::Acquire)
                        && entry.progress.state == DlState::Paused;
                    (
                        Some(entry.progress.clone()),
                        should_resume,
                        Some(Arc::clone(&entry.worker_finished)),
                    )
                }
                None => (None, false, None),
            },
            Err(error) => {
                eprintln!("could not finish download state: {error}");
                (None, false, None)
            }
        };
        if let Some(worker_finished) = worker_finished {
            worker_finished.notify_waiters();
        }
        if let Some(progress) = progress {
            manager.publish(progress);
        }
        if resume_when_online {
            let manager = manager.clone();
            let id = id.clone();
            tokio::spawn(async move {
                if let Err(error) = manager.resume(&id).await {
                    eprintln!(
                        "could not resume download after Offline mode was turned off: {error}"
                    );
                }
            });
        }
    }
}

async fn completed_file_fingerprint(
    spec: &DownloadSpec,
) -> Result<Option<FileFingerprint>, String> {
    let Some(initial) = current_file_fingerprint(&spec.dest)? else {
        return Ok(None);
    };
    if initial.size != spec.size {
        return Ok(None);
    }
    let actual = sha256_file(&spec.dest, &CancellationToken::new(), |_| {})
        .await
        .map_err(|error| {
            format!(
                "could not verify downloaded model {}: {error}",
                spec.dest.display()
            )
        })?;
    if !actual.eq_ignore_ascii_case(&spec.sha256) {
        return Ok(None);
    }
    let Some(current) = current_file_fingerprint(&spec.dest)? else {
        return Ok(None);
    };
    if current.size != spec.size || current != initial {
        return Ok(None);
    }
    Ok(Some(current))
}

fn current_file_fingerprint(path: &Path) -> Result<Option<FileFingerprint>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            file_fingerprint(path, &metadata).map(Some)
        }
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "could not inspect model destination {}: {error}",
            path.display()
        )),
    }
}

fn inspect_restore_files(specs: Vec<DownloadSpec>) -> Result<Vec<RestoreInspection>, String> {
    let mut inspections = Vec::new();
    for spec in specs {
        if !safe_existing_parent(&spec.dest)? {
            continue;
        }
        let complete_file = match std::fs::symlink_metadata(&spec.dest) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                Some(file_fingerprint(&spec.dest, &metadata)?)
            }
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(format!(
                    "could not inspect downloaded model {}: {error}",
                    spec.dest.display()
                ));
            }
        };
        let partial = part_path(&spec.dest);
        let partial_size = match std::fs::symlink_metadata(&partial) {
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() > 0
                    && metadata.len() <= spec.size =>
            {
                Some(metadata.len())
            }
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(format!(
                    "could not inspect partial model download {}: {error}",
                    partial.display()
                ));
            }
        };
        inspections.push(RestoreInspection {
            spec,
            complete_file,
            partial_size,
        });
    }
    Ok(inspections)
}

fn file_fingerprint(path: &Path, metadata: &std::fs::Metadata) -> Result<FileFingerprint, String> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    #[cfg(windows)]
    use std::os::windows::io::AsRawHandle;

    #[cfg(windows)]
    let (volume_serial_number, file_index) = {
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };

        let file = std::fs::File::open(path).map_err(|error| {
            format!(
                "could not open model destination {}: {error}",
                path.display()
            )
        })?;
        let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        let succeeded =
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
        if succeeded == 0 {
            return Err(format!(
                "could not identify model destination {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        let information = unsafe { information.assume_init() };
        (
            Some(information.dwVolumeSerialNumber),
            Some(
                (u64::from(information.nFileIndexHigh) << 32)
                    | u64::from(information.nFileIndexLow),
            ),
        )
    };

    let fingerprint = FileFingerprint {
        size: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(windows)]
        volume_serial_number,
        #[cfg(windows)]
        file_index,
    };
    Ok(fingerprint)
}

impl FileFingerprint {
    fn has_stable_identity(&self) -> bool {
        #[cfg(unix)]
        {
            let _ = (self.device, self.inode);
            true
        }
        #[cfg(windows)]
        {
            self.volume_serial_number.is_some() && self.file_index.is_some()
        }
        #[cfg(not(any(unix, windows)))]
        {
            self.modified.is_some() || self.created.is_some()
        }
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn same_managed_path(expected: &Path, selected: &Path) -> bool {
    same_path(expected, selected)
        || std::fs::canonicalize(expected).is_ok_and(|canonical| same_path(&canonical, selected))
}

fn safe_existing_parent(destination: &Path) -> Result<bool, String> {
    let Some(parent) = destination.parent() else {
        return Ok(false);
    };
    let Some(root) = parent.parent() else {
        return Ok(false);
    };
    let root = match std::fs::canonicalize(root) {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "could not resolve model folder {}: {error}",
                root.display()
            ));
        }
    };
    let metadata = match std::fs::symlink_metadata(parent) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "could not inspect model folder {}: {error}",
                parent.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(false);
    }
    let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
        format!(
            "could not resolve model folder {}: {error}",
            parent.display()
        )
    })?;
    Ok(canonical_parent.starts_with(root))
}

async fn remove_partial(path: &Path) -> Result<(), String> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "could not delete incomplete download {}: {error}",
            path.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aangan_net::Purpose;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;
    use tokio::time::{Duration, sleep, timeout};

    fn spec(dest: PathBuf, size: u64) -> DownloadSpec {
        DownloadSpec {
            id: "model-q4".into(),
            url: "https://huggingface.co/model".into(),
            dest,
            sha256: "0".repeat(64),
            size,
            purpose: Purpose::ModelDownload,
        }
    }

    fn waiting_runner(runs: Arc<AtomicUsize>, started: Arc<Notify>) -> DownloadRunner {
        Arc::new(move |spec, cancellation, on_progress| {
            let runs = Arc::clone(&runs);
            let started = Arc::clone(&started);
            Box::pin(async move {
                runs.fetch_add(1, Ordering::SeqCst);
                on_progress(Progress {
                    id: spec.id,
                    state: DlState::Downloading,
                    done: 3,
                    total: spec.size,
                    bytes_per_sec: 0,
                    eta_secs: None,
                });
                started.notify_one();
                cancellation.cancelled().await;
                Err(DlError::Cancelled)
            })
        })
    }

    fn manager(runner: DownloadRunner) -> DownloadManager {
        DownloadManager::with_runner(runner, Arc::new(|_| {}))
    }

    #[test]
    fn manager_can_start_without_an_entered_tokio_runtime() {
        let gate = NetGate::new().expect("network gate");
        let manager = DownloadManager::new(gate, |_| {});

        assert!(manager.list().expect("download list").is_empty());
    }

    async fn wait_for(manager: &DownloadManager, id: &str, expected: DlState) -> Progress {
        timeout(Duration::from_secs(2), async {
            loop {
                match manager.get(id).expect("manager state") {
                    Some(progress) if progress.state == expected => return progress,
                    _ => {}
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("download state should update")
    }

    #[tokio::test]
    async fn pause_and_resume_runs_the_queued_item_again() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        let partial = part_path(&dest);
        tokio::fs::write(&partial, b"partial")
            .await
            .expect("partial download");
        let runs = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let manager = manager(waiting_runner(Arc::clone(&runs), Arc::clone(&started)));
        let spec = spec(dest, 10);

        manager.start(spec).await.expect("start download");
        started.notified().await;
        manager.pause("model-q4").await.expect("pause download");
        wait_for(&manager, "model-q4", DlState::Paused).await;
        assert!(partial.exists());
        manager.resume("model-q4").await.expect("resume download");
        started.notified().await;
        manager
            .pause("model-q4")
            .await
            .expect("pause resumed download");
        wait_for(&manager, "model-q4", DlState::Paused).await;

        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn retry_while_offline_waits_and_starts_when_back_online() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let runs = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let manager = manager(waiting_runner(Arc::clone(&runs), Arc::clone(&started)));
        manager
            .set_offline(true)
            .await
            .expect("enable offline mode");

        let queued = manager
            .start(spec(directory.path().join("model.gguf"), 10))
            .await
            .expect("start while offline");
        assert_eq!(queued.state, DlState::Paused);
        assert_eq!(
            manager
                .resume("model-q4")
                .await
                .expect("retry while offline")
                .state,
            DlState::Paused
        );
        assert_eq!(runs.load(Ordering::SeqCst), 0);

        manager
            .set_offline(false)
            .await
            .expect("disable offline mode");
        started.notified().await;
        wait_for(&manager, "model-q4", DlState::Downloading).await;
        manager.pause("model-q4").await.expect("pause download");
        wait_for(&manager, "model-q4", DlState::Paused).await;
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn in_flight_download_restarts_if_offline_mode_is_disabled_early() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let runs = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let manager = manager(waiting_runner(Arc::clone(&runs), Arc::clone(&started)));
        manager
            .start(spec(directory.path().join("model.gguf"), 10))
            .await
            .expect("start download");
        started.notified().await;

        manager
            .set_offline(true)
            .await
            .expect("enable offline mode");
        manager
            .set_offline(false)
            .await
            .expect("disable offline mode before stop completes");

        started.notified().await;
        wait_for(&manager, "model-q4", DlState::Downloading).await;
        manager
            .pause("model-q4")
            .await
            .expect("pause resumed download");
        wait_for(&manager, "model-q4", DlState::Paused).await;
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn cancel_can_delete_the_partial_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        let partial = part_path(&dest);
        tokio::fs::write(&partial, b"partial")
            .await
            .expect("partial download");
        let started = Arc::new(Notify::new());
        let manager = manager(waiting_runner(
            Arc::new(AtomicUsize::new(0)),
            Arc::clone(&started),
        ));

        manager.start(spec(dest, 10)).await.expect("start download");
        started.notified().await;
        manager
            .cancel("model-q4", true)
            .await
            .expect("cancel and delete partial");
        let progress = wait_for(&manager, "model-q4", DlState::Cancelled).await;

        assert_eq!(progress.done, 0);
        assert!(!partial.exists());
    }

    #[tokio::test]
    async fn matching_existing_file_is_deduplicated() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        tokio::fs::write(&dest, b"12345")
            .await
            .expect("existing model");
        let runs = Arc::new(AtomicUsize::new(0));
        let manager = manager(waiting_runner(Arc::clone(&runs), Arc::new(Notify::new())));
        let mut existing_spec = spec(dest.clone(), 5);
        existing_spec.sha256 = sha256_file(&dest, &CancellationToken::new(), |_| {})
            .await
            .expect("checksum");

        let progress = manager
            .start(existing_spec)
            .await
            .expect("existing model is recognized");

        assert_eq!(progress.state, DlState::Done);
        assert_eq!(runs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn restore_and_start_reject_existing_file_with_wrong_checksum() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let family = directory.path().join("family");
        tokio::fs::create_dir(&family)
            .await
            .expect("model family folder");
        let dest = family.join("model.gguf");
        tokio::fs::write(&dest, b"12345")
            .await
            .expect("existing model");
        let invalid = spec(dest, 5);
        let manager = manager(waiting_runner(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(Notify::new()),
        ));

        manager
            .restore(vec![invalid.clone()])
            .await
            .expect("restore should inspect the model");

        assert!(manager.get("model-q4").expect("manager state").is_none());
        let error = manager
            .start(invalid)
            .await
            .expect_err("wrong checksum should not be accepted");
        assert!(error.contains("catalog checksum"));
    }

    #[tokio::test]
    async fn restore_marks_file_done_only_after_checksum_validation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let family = directory.path().join("family");
        tokio::fs::create_dir(&family)
            .await
            .expect("model family folder");
        let dest = family.join("model.gguf");
        tokio::fs::write(&dest, b"valid model")
            .await
            .expect("existing model");
        let mut valid = spec(dest.clone(), 11);
        valid.sha256 = sha256_file(&dest, &CancellationToken::new(), |_| {})
            .await
            .expect("checksum");
        let manager = manager(waiting_runner(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(Notify::new()),
        ));

        manager
            .restore(vec![valid])
            .await
            .expect("restore should inspect the model");

        assert_eq!(
            manager
                .get("model-q4")
                .expect("manager state")
                .expect("restored model")
                .state,
            DlState::Done
        );
    }

    #[tokio::test]
    async fn starting_again_after_a_done_file_disappears_queues_a_replacement() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let family = directory.path().join("family");
        tokio::fs::create_dir(&family)
            .await
            .expect("model family folder");
        let dest = family.join("model.gguf");
        tokio::fs::write(&dest, b"valid model")
            .await
            .expect("existing model");
        let mut valid = spec(dest.clone(), 11);
        valid.sha256 = sha256_file(&dest, &CancellationToken::new(), |_| {})
            .await
            .expect("checksum");
        let manager = manager(waiting_runner(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(Notify::new()),
        ));
        manager
            .restore(vec![valid.clone()])
            .await
            .expect("restore existing model");
        tokio::fs::remove_file(&dest)
            .await
            .expect("remove existing model");

        let replacement = manager
            .start(valid)
            .await
            .expect("replacement should be queued");

        assert_eq!(replacement.state, DlState::Queued);
    }

    #[tokio::test]
    async fn storage_delete_reservation_blocks_resume_until_file_is_removed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        let started = Arc::new(Notify::new());
        let manager = manager(waiting_runner(
            Arc::new(AtomicUsize::new(0)),
            Arc::clone(&started),
        ));
        let spec = spec(dest.clone(), 10);

        manager.start(spec.clone()).await.expect("start download");
        started.notified().await;
        manager.pause("model-q4").await.expect("pause download");
        wait_for(&manager, "model-q4", DlState::Paused).await;

        let reservation = manager
            .reserve_storage_delete(&dest)
            .expect("reserve storage deletion");
        assert_eq!(reservation.as_deref(), Some("model-q4"));
        assert!(manager.resume("model-q4").await.is_err());
        manager
            .finish_storage_delete(&dest, reservation.as_deref(), true)
            .expect("finish storage deletion");
        assert!(manager.get("model-q4").expect("manager state").is_none());
        assert!(manager.start(spec).await.is_ok());
    }

    #[tokio::test]
    async fn storage_delete_reservation_blocks_a_new_start_without_an_entry() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        let manager = manager(waiting_runner(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(Notify::new()),
        ));

        let reservation = manager
            .reserve_storage_delete(&dest)
            .expect("reserve storage path");
        assert!(reservation.is_none());
        assert!(manager.start(spec(dest.clone(), 10)).await.is_err());
        manager
            .finish_storage_delete(&dest, None, false)
            .expect("release storage path");
        assert_eq!(
            manager
                .start(spec(dest, 10))
                .await
                .expect("start after deletion")
                .state,
            DlState::Queued
        );
    }

    #[tokio::test]
    async fn concurrent_cancel_waiters_are_all_notified_when_worker_stops() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let runner: DownloadRunner = {
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            Arc::new(move |_, cancellation, _| {
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                Box::pin(async move {
                    started.notify_one();
                    cancellation.cancelled().await;
                    release.notified().await;
                    Err(DlError::Cancelled)
                })
            })
        };
        let manager = manager(runner);
        manager
            .start(spec(directory.path().join("model.gguf"), 10))
            .await
            .expect("start download");
        started.notified().await;

        let first = {
            let manager = manager.clone();
            tokio::spawn(async move { manager.cancel("model-q4", true).await })
        };
        let second = {
            let manager = manager.clone();
            tokio::spawn(async move { manager.cancel("model-q4", true).await })
        };
        sleep(Duration::from_millis(25)).await;
        release.notify_one();

        timeout(Duration::from_secs(2), async {
            first
                .await
                .expect("first cancel task")
                .expect("first cancel");
            second
                .await
                .expect("second cancel task")
                .expect("second cancel");
        })
        .await
        .expect("both cancellation waiters should wake");
    }

    #[tokio::test]
    async fn offline_auto_resume_does_not_deadlock_when_the_queue_is_full() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let started = Arc::new(Notify::new());
        let active_runs = Arc::new(AtomicUsize::new(0));
        let runner: DownloadRunner = {
            let started = Arc::clone(&started);
            let active_runs = Arc::clone(&active_runs);
            Arc::new(move |spec, cancellation, _| {
                let started = Arc::clone(&started);
                let active_runs = Arc::clone(&active_runs);
                Box::pin(async move {
                    if spec.id == "model-q4" && active_runs.fetch_add(1, Ordering::SeqCst) == 0 {
                        started.notify_one();
                        cancellation.cancelled().await;
                        return Err(DlError::Cancelled);
                    }
                    Ok(spec.dest)
                })
            })
        };
        let manager = manager(runner);
        manager
            .start(spec(directory.path().join("active.gguf"), 10))
            .await
            .expect("start active download");
        started.notified().await;

        for index in 0..64 {
            let mut queued = spec(directory.path().join(format!("queued-{index}.gguf")), 10);
            queued.id = format!("queued-{index}");
            manager.start(queued).await.expect("fill worker queue");
        }
        for _ in 0..100 {
            manager
                .resume("queued-0")
                .await
                .expect("queued resume should be idempotent");
        }

        manager
            .set_offline(true)
            .await
            .expect("enable offline mode");
        manager
            .set_offline(false)
            .await
            .expect("disable offline mode");

        assert_eq!(
            wait_for(&manager, "model-q4", DlState::Done).await.state,
            DlState::Done
        );
        assert_eq!(active_runs.load(Ordering::SeqCst), 2);
    }
}
