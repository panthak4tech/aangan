use crate::allow::{is_allowed, Purpose};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fmt,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, Semaphore};
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_ACTIVE: usize = 200;
const MAX_REDIRECTS: usize = 5;
const MAX_LOG: usize = 200;
const EMIT_EVERY: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    Offline,
    Blocked(String),
    Http(String),
    Internal(String),
}

impl fmt::Display for NetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Offline => write!(
                formatter,
                "Offline mode is on. Turn it off in Settings to use the network."
            ),
            Self::Blocked(host) => write!(
                formatter,
                "Blocked connection to {host}: not an allowed host for this action."
            ),
            Self::Http(error) => write!(formatter, "Network error: {error}"),
            Self::Internal(error) => write!(formatter, "Network gate error: {error}"),
        }
    }
}

impl std::error::Error for NetError {}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetRecord {
    pub id: u64,
    pub started_ms: u64,
    pub purpose: Purpose,
    pub host: String,
    pub via: Option<String>,
    pub bytes_down: u64,
    pub ok: Option<bool>,
    pub note: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetState {
    pub offline_mode: bool,
    pub active: usize,
    pub hosts: Vec<String>,
    pub purposes: Vec<Purpose>,
    pub bytes_down: u64,
}

pub struct NetGate {
    client: reqwest::Client,
    enforce: bool,
    offline: AtomicBool,
    cancellation: Mutex<CancellationToken>,
    next_id: AtomicU64,
    log: Mutex<VecDeque<NetRecord>>,
    requests: Arc<Semaphore>,
    tx: broadcast::Sender<NetState>,
}

fn internal_error<T>(error: PoisonError<T>) -> NetError {
    NetError::Internal(format!("shared state lock was poisoned: {error}"))
}

fn now_ms() -> Result<u64, NetError> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| NetError::Internal(format!("system clock error: {error}")))?
        .as_millis();
    u64::try_from(milliseconds)
        .map_err(|error| NetError::Internal(format!("system clock value is out of range: {error}")))
}

fn redirect_is_allowed(enforce: bool, purpose: Purpose, url: &Url) -> bool {
    !enforce || is_allowed(purpose, url)
}

impl NetGate {
    pub fn new() -> Result<Arc<Self>, NetError> {
        Self::build(true)
    }

    #[cfg(feature = "test-util")]
    pub fn new_insecure_for_tests() -> Result<Arc<Self>, NetError> {
        Self::build(false)
    }

    fn build(enforce: bool) -> Result<Arc<Self>, NetError> {
        let client = reqwest::Client::builder()
            .https_only(enforce)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .user_agent(format!("Aangan/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| NetError::Http(error.to_string()))?;
        let (tx, _) = broadcast::channel(64);

        Ok(Arc::new(Self {
            client,
            enforce,
            offline: AtomicBool::new(false),
            cancellation: Mutex::new(CancellationToken::new()),
            next_id: AtomicU64::new(1),
            log: Mutex::new(VecDeque::new()),
            requests: Arc::new(Semaphore::new(MAX_ACTIVE)),
            tx,
        }))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<NetState> {
        self.tx.subscribe()
    }

    pub fn is_offline(&self) -> bool {
        self.offline.load(Ordering::Acquire)
    }

    pub fn set_offline(&self, offline: bool) -> Result<(), NetError> {
        let mut cancellation = self.cancellation.lock().map_err(internal_error)?;
        if self.offline.load(Ordering::Acquire) != offline {
            if offline {
                self.offline.store(true, Ordering::Release);
                cancellation.cancel();
            } else {
                *cancellation = CancellationToken::new();
                self.offline.store(false, Ordering::Release);
            }
        }
        drop(cancellation);
        self.emit()
    }

    pub fn state(&self) -> Result<NetState, NetError> {
        self.snapshot()
    }

    pub fn log(&self) -> Result<Vec<NetRecord>, NetError> {
        let log = self.log.lock().map_err(internal_error)?;
        Ok(log.iter().rev().cloned().collect())
    }

    pub fn clear_log(&self) -> Result<(), NetError> {
        self.log
            .lock()
            .map_err(internal_error)?
            .retain(|record| record.ok.is_none());
        self.emit()
    }

    fn cancellation_token(&self) -> Result<CancellationToken, NetError> {
        let cancellation = self.cancellation.lock().map_err(internal_error)?;
        if self.offline.load(Ordering::Acquire) {
            return Err(NetError::Offline);
        }
        Ok(cancellation.clone())
    }

    fn snapshot(&self) -> Result<NetState, NetError> {
        let log = self.log.lock().map_err(internal_error)?;
        let mut hosts = Vec::new();
        let mut purposes = Vec::new();
        let mut bytes_down = 0;
        let mut active = 0;

        for record in log.iter().filter(|record| record.ok.is_none()) {
            active += 1;
            bytes_down += record.bytes_down;
            let host = record.via.clone().unwrap_or_else(|| record.host.clone());
            if !hosts.contains(&host) {
                hosts.push(host);
            }
            if !purposes.contains(&record.purpose) {
                purposes.push(record.purpose);
            }
        }

        Ok(NetState {
            offline_mode: self.is_offline(),
            active,
            hosts,
            purposes,
            bytes_down,
        })
    }

    fn emit(&self) -> Result<(), NetError> {
        let state = self.snapshot()?;
        let _ = self.tx.send(state);
        Ok(())
    }

    fn begin(&self, purpose: Purpose, host: &str) -> Result<u64, NetError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut log = self.log.lock().map_err(internal_error)?;
        log.push_back(NetRecord {
            id,
            started_ms: now_ms()?,
            purpose,
            host: host.to_string(),
            via: None,
            bytes_down: 0,
            ok: None,
            note: String::new(),
        });
        while log.len() > MAX_LOG {
            match log.iter().position(|record| record.ok.is_some()) {
                Some(position) => {
                    log.remove(position);
                }
                None => break,
            }
        }
        drop(log);
        self.emit()?;
        Ok(id)
    }

    fn update(&self, id: u64, update: impl FnOnce(&mut NetRecord)) -> Result<(), NetError> {
        let mut log = self.log.lock().map_err(internal_error)?;
        if let Some(record) = log.iter_mut().find(|record| record.id == id) {
            update(record);
        }
        Ok(())
    }

    fn end(&self, id: u64, bytes: u64, ok: bool, note: &str) -> Result<(), NetError> {
        self.update(id, |record| {
            record.bytes_down = bytes;
            record.ok = Some(ok);
            record.note = note.to_string();
        })?;
        self.emit()
    }

    pub async fn get(
        self: &Arc<Self>,
        purpose: Purpose,
        url: &str,
        range_from: Option<u64>,
    ) -> Result<NetResponse, NetError> {
        let cancellation = self.cancellation_token()?;
        let mut current =
            Url::parse(url).map_err(|error| NetError::Blocked(format!("invalid URL ({error})")))?;
        if self.enforce && !is_allowed(purpose, &current) {
            return Err(NetError::Blocked(
                current.host_str().unwrap_or("?").to_string(),
            ));
        }

        let permit = tokio::select! {
            _ = cancellation.cancelled() => return Err(NetError::Offline),
            permit = Arc::clone(&self.requests).acquire_owned() => {
                permit.map_err(|error| NetError::Internal(format!("request limiter closed: {error}")))?
            }
        };
        if cancellation.is_cancelled() {
            return Err(NetError::Offline);
        }

        let initial_host = current.host_str().unwrap_or("?").to_string();
        let id = self.begin(purpose, &initial_host)?;
        for _ in 0..=MAX_REDIRECTS {
            let mut request = self.client.get(current.clone());
            if let Some(from) = range_from {
                request = request.header(reqwest::header::RANGE, format!("bytes={from}-"));
            }
            let response = tokio::select! {
                _ = cancellation.cancelled() => {
                    self.end(id, 0, false, "offline mode enabled")?;
                    return Err(NetError::Offline);
                }
                result = request.send() => match result {
                    Ok(response) => response,
                    Err(error) => {
                        let message = error.to_string();
                        self.end(id, 0, false, &message)?;
                        return Err(NetError::Http(message));
                    }
                }
            };

            if response.status().is_redirection() {
                let next = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|location| current.join(location).ok());
                match next {
                    Some(next) if redirect_is_allowed(self.enforce, purpose, &next) => {
                        let next_host = next.host_str().unwrap_or("?").to_string();
                        self.update(id, |record| {
                            record.via = (next_host != initial_host).then_some(next_host);
                        })?;
                        current = next;
                        continue;
                    }
                    Some(next) => {
                        let host = next.host_str().unwrap_or("?").to_string();
                        self.end(id, 0, false, "redirect to a blocked host")?;
                        return Err(NetError::Blocked(host));
                    }
                    None => {
                        self.end(id, 0, false, "invalid redirect")?;
                        return Err(NetError::Http("invalid redirect".into()));
                    }
                }
            }

            return Ok(NetResponse {
                gate: Arc::clone(self),
                id,
                response,
                cancellation,
                _permit: permit,
                downloaded: 0,
                last_emit: Instant::now(),
                finished: false,
            });
        }

        self.end(id, 0, false, "too many redirects")?;
        Err(NetError::Http("too many redirects".into()))
    }
}

pub struct NetResponse {
    gate: Arc<NetGate>,
    id: u64,
    response: reqwest::Response,
    cancellation: CancellationToken,
    _permit: tokio::sync::OwnedSemaphorePermit,
    downloaded: u64,
    last_emit: Instant,
    finished: bool,
}

impl NetResponse {
    pub fn status(&self) -> reqwest::StatusCode {
        self.response.status()
    }

    pub fn content_length(&self) -> Option<u64> {
        self.response.content_length()
    }

    pub async fn chunk(&mut self) -> Result<Option<bytes::Bytes>, NetError> {
        let result = tokio::select! {
            _ = self.cancellation.cancelled() => return Err(NetError::Offline),
            result = self.response.chunk() => result,
        };

        match result {
            Ok(Some(chunk)) => {
                self.downloaded += chunk.len() as u64;
                if self.last_emit.elapsed() >= EMIT_EVERY {
                    self.last_emit = Instant::now();
                    let downloaded = self.downloaded;
                    self.gate.update(self.id, |record| {
                        record.bytes_down = downloaded;
                    })?;
                    self.gate.emit()?;
                }
                Ok(Some(chunk))
            }
            Ok(None) => Ok(None),
            Err(error) => Err(NetError::Http(error.to_string())),
        }
    }

    pub async fn bytes_limited(mut self, max: usize) -> Result<Vec<u8>, NetError> {
        if !self.status().is_success() {
            let status = self.status();
            self.finish(false, &format!("HTTP {status}"))?;
            return Err(NetError::Http(format!("server returned {status}")));
        }

        let mut buffer = Vec::new();
        loop {
            match self.chunk().await {
                Ok(Some(chunk)) => {
                    if buffer.len().saturating_add(chunk.len()) > max {
                        self.finish(false, "too large")?;
                        return Err(NetError::Http("response too large".into()));
                    }
                    buffer.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(error) => {
                    let message = error.to_string();
                    self.finish(false, &message)?;
                    return Err(error);
                }
            }
        }

        self.finish(true, "ok")?;
        Ok(buffer)
    }

    pub fn finish(mut self, ok: bool, note: &str) -> Result<(), NetError> {
        self.gate.end(self.id, self.downloaded, ok, note)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for NetResponse {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self
                .gate
                .end(self.id, self.downloaded, false, "interrupted");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_disallowed_redirect_targets_when_enforcing() {
        let blocked =
            Url::parse("https://example.test/file").expect("blocked test URL should parse");
        let allowed = Url::parse("https://raw.githubusercontent.com/aangan/catalog.json")
            .expect("allowed test URL should parse");

        assert!(!redirect_is_allowed(true, Purpose::Catalog, &blocked));
        assert!(redirect_is_allowed(true, Purpose::Catalog, &allowed));
        assert!(redirect_is_allowed(false, Purpose::Catalog, &blocked));
    }

    #[test]
    fn activity_log_is_bounded_and_newest_first() {
        let gate = NetGate::build(false).expect("gate should build");
        for index in 0..MAX_LOG + 5 {
            let id = gate
                .begin(Purpose::Catalog, "localhost")
                .expect("record should start");
            gate.end(id, index as u64, true, "ok")
                .expect("record should finish");
        }

        let log = gate.log().expect("log should be readable");
        assert_eq!(log.len(), MAX_LOG);
        assert_eq!(log[0].bytes_down, (MAX_LOG + 4) as u64);
        assert_eq!(log[MAX_LOG - 1].bytes_down, 5);
    }

    #[test]
    fn log_eviction_preserves_active_records() {
        let gate = NetGate::build(false).expect("gate should build");
        let active = gate
            .begin(Purpose::Catalog, "localhost")
            .expect("record should start");
        for index in 0..MAX_LOG {
            let id = gate
                .begin(Purpose::Catalog, "localhost")
                .expect("record should start");
            gate.end(id, index as u64, true, "ok")
                .expect("record should finish");
        }

        let log = gate.log().expect("log should be readable");
        assert_eq!(log.len(), MAX_LOG);
        assert!(log.iter().any(|record| record.id == active));
        assert_eq!(gate.state().expect("state should be readable").active, 1);
    }

    #[test]
    fn clear_log_preserves_active_requests() {
        let gate = NetGate::build(false).expect("gate should build");
        let active = gate
            .begin(Purpose::Catalog, "localhost")
            .expect("record should start");
        gate.clear_log().expect("log should clear");
        assert_eq!(gate.log().expect("log should be readable").len(), 1);
        gate.end(active, 0, false, "done")
            .expect("record should finish");
        gate.clear_log().expect("finished record should clear");
        assert!(gate.log().expect("log should be readable").is_empty());
    }

    #[test]
    fn state_reports_only_active_requests() {
        let gate = NetGate::build(false).expect("gate should build");
        let id = gate
            .begin(Purpose::ModelDownload, "huggingface.co")
            .expect("record should start");
        let state = gate.state().expect("state should be readable");
        assert_eq!(state.active, 1);
        assert_eq!(state.hosts, ["huggingface.co"]);
        assert_eq!(state.purposes, [Purpose::ModelDownload]);

        gate.end(id, 7, true, "ok").expect("record should finish");
        assert_eq!(gate.state().expect("state should be readable").active, 0);
    }

    #[test]
    fn broadcasts_updated_network_state() {
        let gate = NetGate::build(false).expect("gate should build");
        let mut events = gate.subscribe();
        let _id = gate
            .begin(Purpose::Catalog, "raw.githubusercontent.com")
            .expect("record should start");

        let event = events.try_recv().expect("state should be broadcast");
        assert_eq!(event.active, 1);
        assert_eq!(event.hosts, ["raw.githubusercontent.com"]);
    }

    #[cfg(feature = "test-util")]
    mod http_tests {
        use super::*;
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
            sync::oneshot,
            time::{timeout, Duration},
        };

        async fn listener() -> (TcpListener, String) {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("listener should bind");
            let address = listener.local_addr().expect("listener should have address");
            (listener, format!("http://{address}"))
        }

        async fn read_request(stream: &mut tokio::net::TcpStream) {
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 512];
                let count = stream
                    .read(&mut chunk)
                    .await
                    .expect("request should be readable");
                assert_ne!(count, 0, "client should send a complete request");
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    return;
                }
            }
        }

        #[tokio::test]
        async fn follows_redirects_and_records_response_bytes() {
            let (listener, base_url) = listener().await;
            let server = tokio::spawn(async move {
                let (mut redirect, _) = listener.accept().await.expect("request should arrive");
                read_request(&mut redirect).await;
                redirect
                    .write_all(b"HTTP/1.1 302 Found\r\nLocation: /file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .expect("redirect should be written");

                let (mut file, _) = listener
                    .accept()
                    .await
                    .expect("redirect should be followed");
                read_request(&mut file).await;
                file.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                )
                .await
                .expect("body should be written");
            });

            let gate = NetGate::new_insecure_for_tests().expect("test gate should build");
            let response = gate
                .get(Purpose::Catalog, &base_url, None)
                .await
                .expect("request should follow its redirect");
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            assert_eq!(
                response.bytes_limited(16).await.expect("body should fit"),
                b"hello"
            );
            server.await.expect("mock server should finish");

            let record = gate.log().expect("log should be readable").remove(0);
            assert_eq!(record.bytes_down, 5);
            assert_eq!(record.ok, Some(true));
            gate.clear_log().expect("completed request should clear");
            assert!(gate.log().expect("log should be readable").is_empty());
        }

        #[tokio::test]
        async fn bytes_limited_rejects_an_oversized_response() {
            let (listener, url) = listener().await;
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("request should arrive");
                read_request(&mut stream).await;
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                    )
                    .await
                    .expect("body should be written");
            });

            let gate = NetGate::new_insecure_for_tests().expect("test gate should build");
            let response = gate
                .get(Purpose::Catalog, &url, None)
                .await
                .expect("request should succeed");
            assert_eq!(
                response.bytes_limited(4).await,
                Err(NetError::Http("response too large".into()))
            );
            server.await.expect("mock server should finish");

            let record = gate.log().expect("log should be readable").remove(0);
            assert_eq!(record.ok, Some(false));
            assert_eq!(record.note, "too large");
        }

        #[tokio::test]
        async fn enabling_offline_aborts_an_in_flight_request() {
            let (listener, url) = listener().await;
            let (accepted_tx, accepted_rx) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("request should arrive");
                read_request(&mut stream).await;
                let _ = accepted_tx.send(());
                tokio::time::sleep(Duration::from_secs(5)).await;
            });

            let gate = NetGate::new_insecure_for_tests().expect("test gate should build");
            let request_gate = Arc::clone(&gate);
            let request = tokio::spawn(async move {
                request_gate
                    .get(Purpose::Catalog, &url, None)
                    .await
                    .map(|_| ())
            });
            timeout(Duration::from_secs(2), accepted_rx)
                .await
                .expect("request should connect")
                .expect("server should signal acceptance");

            gate.set_offline(true).expect("offline mode should enable");
            let result = timeout(Duration::from_secs(2), request)
                .await
                .expect("request should cancel promptly")
                .expect("request task should finish");
            assert_eq!(result, Err(NetError::Offline));
            server.abort();
        }
    }
}
