use aangan_net::download::part_path;
use aangan_net::{DlError, DlState, DownloadSpec, NetError, NetGate, Progress, download};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
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
    on_event: EventCallback,
    offline: AtomicBool,
}

struct DownloadEntry {
    spec: DownloadSpec,
    progress: Progress,
    cancellation: CancellationToken,
    stop: Option<StopAction>,
    worker_running: bool,
    resume_when_online: bool,
    worker_finished: Arc<Notify>,
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
            on_event,
            offline: AtomicBool::new(offline),
        });
        tauri::async_runtime::spawn(run_worker(receiver, Arc::clone(&inner), runner));
        Self { inner }
    }

    pub fn restore(&self, specs: Vec<DownloadSpec>) -> Result<(), String> {
        for spec in &specs {
            if !safe_existing_parent(&spec.dest)? {
                continue;
            }
            match std::fs::symlink_metadata(&spec.dest) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    if metadata.len() == spec.size {
                        self.insert_restored(spec.clone(), DlState::Done, spec.size)?;
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "could not inspect downloaded model {}: {error}",
                        spec.dest.display()
                    ));
                }
            }
        }
        for spec in specs {
            if self.get(&spec.id)?.is_some() {
                continue;
            }
            if !safe_existing_parent(&spec.dest)? {
                continue;
            }
            let partial = part_path(&spec.dest);
            match std::fs::symlink_metadata(&partial) {
                Ok(metadata)
                    if metadata.is_file()
                        && !metadata.file_type().is_symlink()
                        && metadata.len() > 0
                        && metadata.len() <= spec.size =>
                {
                    self.insert_restored(spec.clone(), DlState::Paused, metadata.len())?;
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "could not inspect partial model download {}: {error}",
                        partial.display()
                    ));
                }
            }
        }
        Ok(())
    }

    fn insert_restored(&self, spec: DownloadSpec, state: DlState, done: u64) -> Result<(), String> {
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
            if matches!(
                entry.progress.state,
                DlState::Queued | DlState::Downloading | DlState::Verifying
            ) {
                return Ok(());
            }
            entry.spec = spec;
            entry.progress = progress.clone();
            entry.cancellation = CancellationToken::new();
            entry.stop = None;
        } else {
            entries.insert(
                spec.id.clone(),
                DownloadEntry {
                    spec,
                    progress: progress.clone(),
                    cancellation: CancellationToken::new(),
                    stop: None,
                    worker_running: false,
                    resume_when_online: false,
                    worker_finished: Arc::new(Notify::new()),
                },
            );
        }
        drop(entries);
        self.publish(progress);
        Ok(())
    }

    pub async fn start(&self, spec: DownloadSpec) -> Result<Progress, String> {
        if let Some(existing) = self.get(&spec.id)? {
            if matches!(
                existing.state,
                DlState::Queued
                    | DlState::Downloading
                    | DlState::Verifying
                    | DlState::Paused
                    | DlState::Cancelled
                    | DlState::Failed(_)
            ) {
                return Ok(existing);
            }
            if existing.state == DlState::Done {
                let existing_spec = self
                    .get_spec(&spec.id)?
                    .ok_or_else(|| format!("no download exists for {}", spec.id))?;
                match std::fs::symlink_metadata(&existing_spec.dest) {
                    Ok(metadata)
                        if metadata.is_file()
                            && !metadata.file_type().is_symlink()
                            && metadata.len() == existing_spec.size =>
                    {
                        return Ok(existing);
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "could not inspect model destination {}: {error}",
                            existing_spec.dest.display()
                        ));
                    }
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
                let progress = Progress {
                    id: spec.id.clone(),
                    state: DlState::Done,
                    done: spec.size,
                    total: spec.size,
                    bytes_per_sec: 0,
                    eta_secs: None,
                };
                self.insert_restored(spec, DlState::Done, progress.done)?;
                return Ok(progress);
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
            let mut entries = self
                .inner
                .entries
                .lock()
                .map_err(|error| format!("download state is unavailable: {error}"))?;
            if let Some(existing) = entries.get(&spec.id)
                && matches!(
                    existing.progress.state,
                    DlState::Queued | DlState::Downloading | DlState::Verifying | DlState::Done
                )
            {
                return Ok(existing.progress.clone());
            }
            entries.insert(
                spec.id.clone(),
                DownloadEntry {
                    spec: spec.clone(),
                    progress: progress.clone(),
                    cancellation: CancellationToken::new(),
                    stop: None,
                    worker_running: false,
                    resume_when_online: offline,
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
                (entry.progress.clone(), true)
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
        if let Some(path) = delete_now
            && let Err(error) = remove_partial(&path).await
        {
            self.set_failed(id, &error);
            return Err(error);
        }
        if let Some(progress) = publish {
            self.publish(progress.clone());
        }
        if let Some(notify) = wait_for_worker {
            loop {
                let notified = notify.notified();
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
        if let Some(entry) = entries.get(id)
            && matches!(
                entry.progress.state,
                DlState::Queued | DlState::Downloading | DlState::Verifying
            )
        {
            return Err("pause or cancel the download before deleting its file".into());
        }
        entries.remove(id);
        Ok(())
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
                entry.stop = None;
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
            worker_finished.notify_one();
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
        if delete_partial && let Err(error) = remove_partial(&part_path(&spec.dest)).await {
            manager.set_failed(&id, &error);
            continue;
        }
        let (progress, resume_when_online, worker_finished) = match inner.entries.lock() {
            Ok(mut entries) => match entries.get_mut(&id) {
                Some(entry) => {
                    entry.progress.state = state;
                    entry.worker_running = false;
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
            worker_finished.notify_one();
        }
        if let Some(progress) = progress {
            manager.publish(progress);
        }
        if resume_when_online && let Err(error) = manager.resume(&id).await {
            eprintln!("could not resume download after Offline mode was turned off: {error}");
        }
    }
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
                if let Some(progress) = manager.get(id).expect("manager state")
                    && progress.state == expected
                {
                    return progress;
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

        let progress = manager
            .start(spec(dest, 5))
            .await
            .expect("existing model is recognized");

        assert_eq!(progress.state, DlState::Done);
        assert_eq!(runs.load(Ordering::SeqCst), 0);
    }
}
