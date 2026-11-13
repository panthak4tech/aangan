use crate::{
    allow::Purpose,
    gate::{NetError, NetGate},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
};
use tokio_util::sync::CancellationToken;

pub const DISK_HEADROOM: u64 = 512 * 1024 * 1024;
const REPORT_EVERY: Duration = Duration::from_millis(200);

#[derive(Clone, Debug)]
pub struct DownloadSpec {
    pub id: String,
    pub url: String,
    pub dest: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub purpose: Purpose,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum DlState {
    Queued,
    Downloading,
    Verifying,
    Done,
    Paused,
    Cancelled,
    Failed(String),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub state: DlState,
    pub done: u64,
    pub total: u64,
    pub bytes_per_sec: u64,
    pub eta_secs: Option<u64>,
}

#[derive(Debug)]
pub enum DlError {
    Cancelled,
    Net(NetError),
    DiskSpace { needed: u64, free: u64 },
    UnexpectedStatus(u16),
    Size { expected: u64, actual: u64 },
    Checksum,
    Io(String),
}

impl fmt::Display for DlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => write!(formatter, "Download stopped."),
            Self::Net(error) => write!(formatter, "{error}"),
            Self::DiskSpace { needed, free } => write!(
                formatter,
                "Not enough free disk space: need about {needed} bytes, {free} available."
            ),
            Self::UnexpectedStatus(status) => write!(
                formatter,
                "The server answered with an unexpected status ({status})."
            ),
            Self::Size { expected, actual } => write!(
                formatter,
                "The file size is not what the catalog expects ({actual} instead of {expected} bytes)."
            ),
            Self::Checksum => write!(
                formatter,
                "The downloaded file is corrupted (checksum mismatch). It was deleted; please try again."
            ),
            Self::Io(error) => write!(formatter, "File error: {error}"),
        }
    }
}

impl std::error::Error for DlError {}

impl From<NetError> for DlError {
    fn from(error: NetError) -> Self {
        Self::Net(error)
    }
}

fn io_error(error: impl fmt::Display) -> DlError {
    DlError::Io(error.to_string())
}

pub fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

pub fn resume_offset(existing: u64, expected: u64) -> u64 {
    if existing <= expected {
        existing
    } else {
        0
    }
}

pub fn eta_secs(remaining: u64, bytes_per_sec: u64) -> Option<u64> {
    (bytes_per_sec > 0).then(|| remaining / bytes_per_sec)
}

pub struct SpeedMeter {
    last_at: Instant,
    last_bytes: u64,
    ema: f64,
}

impl SpeedMeter {
    pub fn new(start_bytes: u64) -> Self {
        Self {
            last_at: Instant::now(),
            last_bytes: start_bytes,
            ema: 0.0,
        }
    }

    pub fn update(&mut self, now: Instant, bytes: u64) -> u64 {
        let elapsed = now.duration_since(self.last_at).as_secs_f64();
        if elapsed >= 0.5 {
            let instant_rate = bytes.saturating_sub(self.last_bytes) as f64 / elapsed;
            self.ema = if self.ema == 0.0 {
                instant_rate
            } else {
                0.7 * self.ema + 0.3 * instant_rate
            };
            self.last_at = now;
            self.last_bytes = bytes;
        }
        self.ema as u64
    }
}

pub async fn sha256_file(
    path: &Path,
    cancel: &CancellationToken,
    mut on_bytes: impl FnMut(u64),
) -> Result<String, DlError> {
    let mut file = fs::File::open(path).await.map_err(io_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 20];
    let mut read_total = 0_u64;
    loop {
        if cancel.is_cancelled() {
            return Err(DlError::Cancelled);
        }
        let read = file.read(&mut buffer).await.map_err(io_error)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        read_total += read as u64;
        on_bytes(read_total);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn progress(spec: &DownloadSpec, state: DlState, done: u64, bytes_per_sec: u64) -> Progress {
    Progress {
        id: spec.id.clone(),
        state,
        done,
        total: spec.size,
        bytes_per_sec,
        eta_secs: eta_secs(spec.size.saturating_sub(done), bytes_per_sec),
    }
}

fn check_disk_space(size: u64, offset: u64, free: u64) -> Result<(), DlError> {
    let needed = size.saturating_sub(offset).saturating_add(DISK_HEADROOM);
    if free < needed {
        return Err(DlError::DiskSpace { needed, free });
    }
    Ok(())
}

async fn existing_part_len(path: &Path) -> Result<u64, DlError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            Ok(metadata.len())
        }
        Ok(_) => Err(DlError::Io(format!(
            "partial download path is not a regular file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(io_error(error)),
    }
}

fn open_part_file(path: &Path, append: bool) -> Result<fs::File, DlError> {
    let mut options = std::fs::OpenOptions::new();
    if append {
        options.append(true);
    } else {
        options.write(true).create(true).truncate(true);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }

    let file = options.open(path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(DlError::Io(format!(
            "partial download path is not a regular file: {}",
            path.display()
        )));
    }
    Ok(fs::File::from_std(file))
}

async fn remove_part(path: &Path) -> Result<(), DlError> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

pub async fn download<F>(
    gate: &Arc<NetGate>,
    spec: &DownloadSpec,
    cancel: &CancellationToken,
    on_progress: F,
) -> Result<PathBuf, DlError>
where
    F: Fn(Progress),
{
    let part = part_path(&spec.dest);
    let dir = spec
        .dest
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).await.map_err(io_error)?;

    let existing = existing_part_len(&part).await?;
    let mut offset = resume_offset(existing, spec.size);
    if offset == 0 && existing > 0 {
        remove_part(&part).await?;
    }

    let free = fs4::available_space(dir).map_err(io_error)?;
    check_disk_space(spec.size, offset, free)?;

    let mut done = offset;
    if offset < spec.size {
        if cancel.is_cancelled() {
            return Err(DlError::Cancelled);
        }
        on_progress(progress(spec, DlState::Downloading, done, 0));
        let mut response = gate
            .get(spec.purpose, &spec.url, (offset > 0).then_some(offset))
            .await?;
        let status = response.status().as_u16();
        match (offset > 0, status) {
            (false, 200) | (true, 206) => {}
            (true, 200) => {
                offset = 0;
                done = 0;
            }
            (_, status) => return Err(DlError::UnexpectedStatus(status)),
        }

        if let Some(length) = response.content_length() {
            let expected = spec.size.saturating_sub(offset);
            if length != expected {
                return Err(DlError::Size {
                    expected,
                    actual: length,
                });
            }
        }

        let mut file = open_part_file(&part, offset > 0)?;
        let mut meter = SpeedMeter::new(done);
        let mut last_report = Instant::now();
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => {
                    file.flush().await.map_err(|error| {
                        DlError::Io(format!("could not save the partial download before stopping: {error}"))
                    })?;
                    return Err(DlError::Cancelled);
                }
                chunk = response.chunk() => chunk?,
            };
            let Some(bytes) = next else {
                break;
            };
            let next_done = done.saturating_add(bytes.len() as u64);
            if next_done > spec.size {
                return Err(DlError::Size {
                    expected: spec.size,
                    actual: next_done,
                });
            }
            file.write_all(&bytes).await.map_err(io_error)?;
            done = next_done;
            let now = Instant::now();
            if now.duration_since(last_report) >= REPORT_EVERY {
                let bytes_per_sec = meter.update(now, done);
                on_progress(progress(spec, DlState::Downloading, done, bytes_per_sec));
                last_report = now;
            }
        }
        file.flush().await.map_err(io_error)?;
        drop(file);
        response.finish(true, "ok")?;
        if done != spec.size {
            return Err(DlError::Size {
                expected: spec.size,
                actual: done,
            });
        }
    }

    on_progress(progress(spec, DlState::Verifying, 0, 0));
    let actual = sha256_file(&part, cancel, |read| {
        on_progress(progress(spec, DlState::Verifying, read, 0));
    })
    .await?;
    if !actual.eq_ignore_ascii_case(&spec.sha256) {
        match fs::remove_file(&part).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(DlError::Io(format!(
                    "checksum mismatch; could not remove the partial file {}: {error}",
                    part.display()
                )));
            }
        }
        return Err(DlError::Checksum);
    }
    fs::rename(&part, &spec.dest).await.map_err(io_error)?;
    on_progress(progress(spec, DlState::Done, spec.size, 0));
    Ok(spec.dest.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        extract::State,
        http::{header, HeaderMap, HeaderValue, Response, StatusCode},
        routing::get,
        Router,
    };
    use bytes::Bytes;
    use futures_util::stream;
    use std::convert::Infallible;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::sync::Mutex;
    use tokio::{net::TcpListener, task::JoinHandle};

    #[test]
    fn part_path_appends_suffix() {
        assert_eq!(
            part_path(Path::new("models/model.gguf")),
            PathBuf::from("models/model.gguf.part")
        );
    }

    #[test]
    fn resume_offset_restarts_if_partial_is_too_large() {
        assert_eq!(resume_offset(0, 100), 0);
        assert_eq!(resume_offset(60, 100), 60);
        assert_eq!(resume_offset(100, 100), 100);
        assert_eq!(resume_offset(101, 100), 0);
    }

    #[test]
    fn eta_handles_zero_rate() {
        assert_eq!(eta_secs(1000, 0), None);
        assert_eq!(eta_secs(1000, 100), Some(10));
    }

    #[test]
    fn speed_meter_smooths_and_decays_when_stalled() {
        let mut meter = SpeedMeter::new(0);
        let start = meter.last_at;
        assert_eq!(meter.update(start + Duration::from_millis(100), 1000), 0);
        let first = meter.update(start + Duration::from_secs(1), 1000);
        assert_eq!(first, 1000);
        let stalled = meter.update(start + Duration::from_secs(2), 1000);
        assert!(stalled > 0 && stalled < first);
    }

    #[test]
    fn disk_space_check_includes_headroom_and_remaining_size() {
        assert!(matches!(
            check_disk_space(1000, 400, DISK_HEADROOM + 599),
            Err(DlError::DiskSpace { needed, free })
                if needed == DISK_HEADROOM + 600 && free == DISK_HEADROOM + 599
        ));
        assert!(check_disk_space(1000, 400, DISK_HEADROOM + 600).is_ok());
    }

    #[derive(Clone)]
    struct ServerConfig {
        bytes: Vec<u8>,
        ignore_range: bool,
        content_length: Option<u64>,
        chunk_size: Option<usize>,
        chunk_delay: Duration,
    }

    struct TestServer {
        url: String,
        task: JoinHandle<()>,
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn test_handler(
        State(config): State<ServerConfig>,
        headers: HeaderMap,
    ) -> Response<Body> {
        let requested_offset = headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("bytes="))
            .and_then(|value| value.strip_suffix('-'))
            .and_then(|value| value.parse::<usize>().ok());
        let (status, mut body) = match requested_offset {
            Some(offset) if !config.ignore_range && offset <= config.bytes.len() => {
                (StatusCode::PARTIAL_CONTENT, config.bytes[offset..].to_vec())
            }
            _ => (StatusCode::OK, config.bytes.clone()),
        };
        if let Some(length) = config.content_length {
            body.truncate(usize::try_from(length).unwrap_or(usize::MAX));
        }
        let length = config.content_length.unwrap_or(body.len() as u64);
        let response_body = if let Some(chunk_size) = config.chunk_size {
            let bytes = body;
            let chunk_delay = config.chunk_delay;
            Body::from_stream(stream::unfold(
                (bytes, 0),
                move |(bytes, offset)| async move {
                    if offset >= bytes.len() {
                        return None;
                    }
                    if !chunk_delay.is_zero() {
                        tokio::time::sleep(chunk_delay).await;
                    }
                    let end = offset.saturating_add(chunk_size).min(bytes.len());
                    let chunk = Bytes::copy_from_slice(&bytes[offset..end]);
                    Some((Ok::<_, Infallible>(chunk), (bytes, end)))
                },
            ))
        } else {
            Body::from(body)
        };
        let mut builder = Response::builder().status(status).header(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&length.to_string()).expect("content length is valid"),
        );
        if status == StatusCode::PARTIAL_CONTENT {
            let start = requested_offset.unwrap_or_default();
            let end = config.bytes.len().saturating_sub(1);
            builder = builder.header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{}", config.bytes.len()),
            );
        }
        builder
            .body(response_body)
            .expect("test response should be valid")
    }

    async fn start_server(config: ServerConfig) -> TestServer {
        let app = Router::new()
            .route("/model.gguf", get(test_handler))
            .with_state(config);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock server should bind");
        let address = listener
            .local_addr()
            .expect("mock server should have a local address");
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("mock server should run");
        });
        TestServer {
            url: format!("http://{address}/model.gguf"),
            task,
        }
    }

    fn spec(url: String, dest: PathBuf, bytes: &[u8]) -> DownloadSpec {
        DownloadSpec {
            id: "test-model".into(),
            url,
            dest,
            sha256: hex::encode(Sha256::digest(bytes)),
            size: bytes.len() as u64,
            purpose: Purpose::ModelDownload,
        }
    }

    fn progress_log() -> (Arc<Mutex<Vec<Progress>>>, impl Fn(Progress)) {
        let items = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&items);
        (items, move |progress| {
            captured
                .lock()
                .expect("progress mutex should not be poisoned")
                .push(progress);
        })
    }

    #[tokio::test]
    async fn full_download_verifies_and_reports_done() {
        let bytes = b"model bytes".to_vec();
        let server = start_server(ServerConfig {
            bytes: bytes.clone(),
            ignore_range: false,
            content_length: None,
            chunk_size: None,
            chunk_delay: Duration::ZERO,
        })
        .await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let spec = spec(
            server.url.clone(),
            directory.path().join("model.gguf"),
            &bytes,
        );
        let gate = NetGate::new_insecure_for_tests().expect("test network gate");
        let (progress, on_progress) = progress_log();

        let result = download(&gate, &spec, &CancellationToken::new(), on_progress)
            .await
            .expect("download should succeed");

        assert_eq!(fs::read(result).await.expect("downloaded file"), bytes);
        assert_eq!(
            progress
                .lock()
                .expect("progress mutex")
                .last()
                .map(|p| p.state.clone()),
            Some(DlState::Done)
        );
        let log = gate.log().expect("network log");
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].bytes_down, bytes.len() as u64);
        assert_eq!(log[0].ok, Some(true));
    }

    #[tokio::test]
    async fn resumes_from_existing_partial_file_with_range() {
        let bytes = b"model bytes".to_vec();
        let server = start_server(ServerConfig {
            bytes: bytes.clone(),
            ignore_range: false,
            content_length: None,
            chunk_size: None,
            chunk_delay: Duration::ZERO,
        })
        .await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        fs::write(part_path(&dest), &bytes[..5])
            .await
            .expect("partial file");
        let spec = spec(server.url.clone(), dest.clone(), &bytes);
        let gate = NetGate::new_insecure_for_tests().expect("test network gate");
        let (progress, on_progress) = progress_log();

        download(&gate, &spec, &CancellationToken::new(), on_progress)
            .await
            .expect("resumed download should succeed");

        assert_eq!(fs::read(dest).await.expect("downloaded file"), bytes);
        assert!(progress
            .lock()
            .expect("progress mutex")
            .iter()
            .any(|item| item.state == DlState::Downloading && item.done == 5));
    }

    #[tokio::test]
    async fn restarts_when_server_ignores_range_request() {
        let bytes = b"model bytes".to_vec();
        let server = start_server(ServerConfig {
            bytes: bytes.clone(),
            ignore_range: true,
            content_length: None,
            chunk_size: None,
            chunk_delay: Duration::ZERO,
        })
        .await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        fs::write(part_path(&dest), &bytes[..5])
            .await
            .expect("partial file");
        let spec = spec(server.url.clone(), dest.clone(), &bytes);
        let gate = NetGate::new_insecure_for_tests().expect("test network gate");

        download(&gate, &spec, &CancellationToken::new(), |_| {})
            .await
            .expect("download should restart from zero");

        assert_eq!(fs::read(dest).await.expect("downloaded file"), bytes);
    }

    #[tokio::test]
    async fn checksum_failure_removes_partial_file() {
        let bytes = b"model bytes".to_vec();
        let server = start_server(ServerConfig {
            bytes: bytes.clone(),
            ignore_range: false,
            content_length: None,
            chunk_size: None,
            chunk_delay: Duration::ZERO,
        })
        .await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        let mut spec = spec(server.url.clone(), dest.clone(), &bytes);
        spec.sha256 = hex::encode(Sha256::digest(b"wrong"));
        let part = part_path(&dest);
        let gate = NetGate::new_insecure_for_tests().expect("test network gate");

        let error = download(&gate, &spec, &CancellationToken::new(), |_| {})
            .await
            .expect_err("wrong checksum should fail");

        assert!(matches!(error, DlError::Checksum));
        assert!(!part.exists());
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn rejects_wrong_content_length() {
        let bytes = b"model bytes".to_vec();
        let server = start_server(ServerConfig {
            bytes: bytes.clone(),
            ignore_range: false,
            content_length: Some(2),
            chunk_size: None,
            chunk_delay: Duration::ZERO,
        })
        .await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let spec = spec(
            server.url.clone(),
            directory.path().join("model.gguf"),
            &bytes,
        );
        let gate = NetGate::new_insecure_for_tests().expect("test network gate");

        let error = download(&gate, &spec, &CancellationToken::new(), |_| {})
            .await
            .expect_err("wrong content length should fail");

        assert!(matches!(
            error,
            DlError::Size {
                expected: 11,
                actual: 2
            }
        ));
    }

    #[tokio::test]
    async fn cancellation_after_streaming_bytes_keeps_resumable_partial() {
        let bytes = vec![b'm'; 2 * 1024 * 1024];
        let server = start_server(ServerConfig {
            bytes: bytes.clone(),
            ignore_range: false,
            content_length: None,
            chunk_size: Some(64 * 1024),
            chunk_delay: Duration::from_millis(5),
        })
        .await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        let part = part_path(&dest);
        let spec = spec(server.url.clone(), dest.clone(), &bytes);
        let gate = NetGate::new_insecure_for_tests().expect("test network gate");
        let cancellation = CancellationToken::new();
        let cancel_after_write = cancellation.clone();
        let wait_for_bytes = part.clone();
        let cancel_task = tokio::spawn(async move {
            let started = Instant::now();
            loop {
                if std::fs::metadata(&wait_for_bytes).is_ok_and(|metadata| metadata.len() > 0) {
                    cancel_after_write.cancel();
                    return true;
                }
                if started.elapsed() > Duration::from_secs(10) {
                    return false;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });

        let error = download(&gate, &spec, &cancellation, |_| {})
            .await
            .expect_err("cancelled download should stop");
        assert!(cancel_task.await.expect("cancel task should complete"));

        assert!(matches!(error, DlError::Cancelled));
        let partial = fs::read(&part).await.expect("partial file");
        assert!(!partial.is_empty());
        assert!(partial.len() < bytes.len());

        download(&gate, &spec, &CancellationToken::new(), |_| {})
            .await
            .expect("partial download should resume");
        assert_eq!(fs::read(dest).await.expect("downloaded file"), bytes);
    }

    #[tokio::test]
    async fn cancellation_during_hashing_keeps_partial_file_for_retry() {
        let bytes = vec![b'h'; 2 * 1024 * 1024];
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        let part = part_path(&dest);
        fs::write(&part, &bytes)
            .await
            .expect("complete partial file");
        let spec = spec("http://127.0.0.1/model.gguf".into(), dest.clone(), &bytes);
        let gate = NetGate::new_insecure_for_tests().expect("test network gate");
        let cancellation = CancellationToken::new();
        let callback_cancel = cancellation.clone();

        let error = download(&gate, &spec, &cancellation, move |progress| {
            if progress.state == DlState::Verifying && progress.done > 0 {
                callback_cancel.cancel();
            }
        })
        .await
        .expect_err("cancelled hashing should stop");

        assert!(matches!(error, DlError::Cancelled));
        assert_eq!(fs::read(&part).await.expect("partial file"), bytes);

        download(&gate, &spec, &CancellationToken::new(), |_| {})
            .await
            .expect("retry should verify and finish");
        assert_eq!(fs::read(dest).await.expect("downloaded file"), bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlinked_partial_before_reading_or_opening_it() {
        let bytes = b"model bytes".to_vec();
        let server = start_server(ServerConfig {
            bytes: bytes.clone(),
            ignore_range: false,
            content_length: None,
            chunk_size: None,
            chunk_delay: Duration::ZERO,
        })
        .await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let dest = directory.path().join("model.gguf");
        let outside = directory.path().join("outside");
        fs::write(&outside, b"outside file")
            .await
            .expect("outside file");
        symlink(&outside, part_path(&dest)).expect("partial symlink");
        let spec = spec(server.url.clone(), dest, &bytes);
        let gate = NetGate::new_insecure_for_tests().expect("test network gate");

        let error = download(&gate, &spec, &CancellationToken::new(), |_| {})
            .await
            .expect_err("symlinked partial should be rejected");

        assert!(matches!(error, DlError::Io(_)));
        assert!(open_part_file(&part_path(&spec.dest), true).is_err());
        assert_eq!(
            fs::read(outside).await.expect("outside file"),
            b"outside file"
        );
    }
}
