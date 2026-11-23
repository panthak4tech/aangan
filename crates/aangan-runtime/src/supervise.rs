use std::{
    env,
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

pub fn free_loopback_port() -> io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn random_key_with(fill: impl FnOnce(&mut [u8]) -> io::Result<()>) -> io::Result<String> {
    let mut bytes = [0u8; 32];
    fill(&mut bytes)?;
    Ok(hex::encode(bytes))
}

pub fn random_key() -> io::Result<String> {
    random_key_with(|bytes| {
        getrandom::fill(bytes).map_err(|error| io::Error::other(error.to_string()))
    })
}

pub fn loopback_status(port: u16, path: &str, timeout: Duration) -> io::Result<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let started = Instant::now();
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    let remaining = timeout.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "health check timed out",
        ));
    }
    stream.set_read_timeout(Some(remaining))?;
    stream.set_write_timeout(Some(remaining))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )?;
    const MAX_STATUS_LINE_BYTES: usize = 1024;
    let mut status_line = Vec::with_capacity(64);
    let mut buf = [0u8; 128];
    loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "health check timed out",
            ));
        }
        stream.set_read_timeout(Some(remaining))?;
        let read = stream.read(&mut buf).map_err(normalize_timeout_error)?;
        if started.elapsed() >= timeout {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "health check timed out",
            ));
        }
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "health check closed before the status line completed",
            ));
        }
        let line_end = buf[..read].iter().position(|byte| *byte == b'\n');
        let count = line_end.map_or(read, |index| index + 1);
        if status_line.len() + count > MAX_STATUS_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "health check status line is too long",
            ));
        }
        status_line.extend_from_slice(&buf[..count]);
        if line_end.is_some() {
            break;
        }
    }
    let head = std::str::from_utf8(&status_line)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad status line"))?;
    head.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad status line"))
}

fn normalize_timeout_error(error: io::Error) -> io::Error {
    if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) {
        io::Error::new(io::ErrorKind::TimedOut, error)
    } else {
        error
    }
}

pub struct LaunchParams {
    pub exe: PathBuf,
    pub model: PathBuf,
    pub port: u16,
    pub ctx: u32,
    pub gpu_layers: i32,
    pub threads: Option<u32>,
}

pub fn build_args(params: &LaunchParams) -> Vec<String> {
    let mut args = vec![
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        params.port.to_string(),
        "-m".into(),
        params.model.to_string_lossy().into_owned(),
        "-c".into(),
        params.ctx.to_string(),
        "-ngl".into(),
        params.gpu_layers.to_string(),
        "--no-webui".into(),
    ];
    if let Some(threads) = params.threads {
        args.push("-t".into());
        args.push(threads.to_string());
    }
    args
}

pub fn is_blocked_env(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    name.starts_with("LLAMA_")
        || name.starts_with("HF_")
        || name == "HTTP_PROXY"
        || name == "HTTPS_PROXY"
        || name == "ALL_PROXY"
        || name == "NO_PROXY"
}

fn remove_blocked_env_names(
    command: &mut Command,
    names: impl IntoIterator<Item = std::ffi::OsString>,
) {
    for name in names {
        if is_blocked_env(&name.to_string_lossy()) {
            command.env_remove(name);
        }
    }
}

pub fn remove_blocked_env(command: &mut Command) {
    remove_blocked_env_names(command, env::vars_os().map(|(name, _)| name));
}

fn prepare_api_key_help_command(
    command: &mut Command,
    inherited_names: impl IntoIterator<Item = std::ffi::OsString>,
) {
    command.arg("--help").stdin(Stdio::null());
    remove_blocked_env_names(command, inherited_names);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn bounded_output(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    let deadline = Instant::now() + timeout;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("API-key capability probe stdout was not captured"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("API-key capability probe stderr was not captured"))?;
    let stdout_reader = thread::spawn(move || read_probe_pipe(stdout));
    let stderr_reader = thread::spawn(move || read_probe_pipe(stderr));

    let status = loop {
        match child.try_wait() {
            Err(error) => {
                let cleanup = terminate_probe(&mut child, Duration::from_secs(1));
                drop(stdout_reader);
                drop(stderr_reader);
                if let Err(cleanup_error) = cleanup {
                    return Err(io::Error::other(format!(
                        "API-key capability probe failed: {error}; cleanup failed: {cleanup_error}"
                    )));
                }
                return Err(error);
            }
            Ok(Some(status)) => break status,
            Ok(None) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    let cleanup = terminate_probe(&mut child, Duration::from_secs(1));
                    drop(stdout_reader);
                    drop(stderr_reader);
                    return Err(match cleanup {
                        Ok(()) => io::Error::new(
                            io::ErrorKind::TimedOut,
                            "API-key capability probe timed out",
                        ),
                        Err(error) => io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!("API-key capability probe timed out; cleanup failed: {error}"),
                        ),
                    });
                }
                thread::sleep(Duration::from_millis(20).min(remaining));
            }
        }
    };
    let (stdout, stderr) = collect_probe_output_until(stdout_reader, stderr_reader, deadline)?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn terminate_probe(child: &mut std::process::Child, timeout: Duration) -> io::Result<()> {
    let kill_error = child.kill().err();
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return kill_error.map_or(Ok(()), Err);
            }
            Ok(None) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "timed out reaping the API-key capability probe",
                    ));
                }
                thread::sleep(Duration::from_millis(20).min(remaining));
            }
            Err(error) => return Err(error),
        }
    }
}

fn read_probe_pipe(mut reader: impl Read) -> io::Result<Vec<u8>> {
    const MAX_CAPTURE_BYTES: usize = 64 * 1024;
    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    let mut exceeded_limit = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = MAX_CAPTURE_BYTES.saturating_sub(output.len());
        exceeded_limit |= read > remaining;
        output.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    if exceeded_limit {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "API-key capability probe output exceeded 64 KiB",
        ))
    } else {
        Ok(output)
    }
}

fn collect_probe_output_until(
    stdout_reader: thread::JoinHandle<io::Result<Vec<u8>>>,
    stderr_reader: thread::JoinHandle<io::Result<Vec<u8>>>,
    deadline: Instant,
) -> io::Result<(Vec<u8>, Vec<u8>)> {
    while !stdout_reader.is_finished() || !stderr_reader.is_finished() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "API-key capability probe output did not close before the deadline",
            ));
        }
        thread::sleep(Duration::from_millis(20).min(remaining));
    }
    let stdout = stdout_reader
        .join()
        .map_err(|_| io::Error::other("API-key probe stdout reader panicked"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| io::Error::other("API-key probe stderr reader panicked"))??;
    Ok((stdout, stderr))
}

pub fn redact(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        text.to_string()
    } else {
        text.replace(secret, "<redacted>")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiKeyMode {
    Environment,
    Argument,
}

pub fn api_key_mode_from_help(help: &str) -> ApiKeyMode {
    let help = help.to_ascii_lowercase();
    if help.contains("llama_api_key") || help.contains("llama_arg_api_key") {
        ApiKeyMode::Environment
    } else if help.contains("--api-key") {
        ApiKeyMode::Argument
    } else {
        ApiKeyMode::Environment
    }
}

fn api_key_mode_from_probe(success: bool, help: &str) -> io::Result<ApiKeyMode> {
    if !success {
        return Err(io::Error::other(
            "API-key capability probe exited unsuccessfully",
        ));
    }
    Ok(api_key_mode_from_help(help))
}

pub fn api_key_mode(exe: &Path) -> io::Result<ApiKeyMode> {
    let mut command = Command::new(exe);
    prepare_api_key_help_command(&mut command, env::vars_os().map(|(name, _)| name));
    let output = bounded_output(&mut command, Duration::from_secs(5))?;
    let help = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    api_key_mode_from_probe(output.status.success(), &help)
}

#[cfg(windows)]
pub mod job {
    use std::{io, mem, os::windows::io::AsRawHandle, process::Child};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    pub struct KillOnCloseJob(HANDLE);
    unsafe impl Send for KillOnCloseJob {}
    unsafe impl Sync for KillOnCloseJob {}

    impl KillOnCloseJob {
        pub fn new() -> io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    mem::size_of_val(&info) as u32,
                );
                if ok == 0 {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                Ok(Self(job))
            }
        }

        pub fn assign(&self, child: &Child) -> io::Result<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    impl Drop for KillOnCloseJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsString, thread};

    #[test]
    fn args_bind_loopback_and_do_not_contain_secrets() {
        let params = LaunchParams {
            exe: "llama-server.exe".into(),
            model: "C:/models/model.gguf".into(),
            port: 4242,
            ctx: 4096,
            gpu_layers: 999,
            threads: Some(8),
        };
        let args = build_args(&params);
        assert!(args.windows(2).any(|pair| pair == ["--host", "127.0.0.1"]));
        assert!(args.windows(2).any(|pair| pair == ["--port", "4242"]));
        assert!(!args.iter().any(|arg| arg == "--api-key" || arg == "-hf"));
    }

    #[test]
    fn env_filter_blocks_download_and_proxy_variables() {
        assert!(is_blocked_env("LLAMA_ARG_HF_REPO"));
        assert!(is_blocked_env("HF_TOKEN"));
        assert!(is_blocked_env("HTTPS_PROXY"));
        assert!(is_blocked_env("no_proxy"));
        assert!(!is_blocked_env("SystemRoot"));
        assert!(!is_blocked_env("PATH"));
    }

    #[test]
    fn api_key_help_command_filters_blocked_names_and_preserves_system_names() {
        let mut command = Command::new("llama-server");
        prepare_api_key_help_command(
            &mut command,
            [
                "LLAMA_API_KEY",
                "HF_TOKEN",
                "https_proxy",
                "NO_PROXY",
                "PATH",
                "SystemRoot",
            ]
            .map(OsString::from),
        );

        assert_eq!(
            command.get_args().next(),
            Some(std::ffi::OsStr::new("--help"))
        );
        assert!(command
            .get_envs()
            .any(|(name, value)| { name == "LLAMA_API_KEY" && value.is_none() }));
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "HF_TOKEN" && value.is_none()));
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "https_proxy" && value.is_none()));
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "NO_PROXY" && value.is_none()));
        assert!(!command
            .get_envs()
            .any(|(name, _)| name == "PATH" || name == "SystemRoot"));
    }

    #[test]
    fn redact_replaces_the_secret() {
        assert_eq!(
            redact("Authorization: secret", "secret"),
            "Authorization: <redacted>"
        );
        assert_eq!(redact("no secret", ""), "no secret");
    }

    #[test]
    fn api_key_help_selects_environment_or_argument() {
        assert_eq!(
            api_key_mode_from_help("LLAMA_API_KEY env var supported"),
            ApiKeyMode::Environment
        );
        assert_eq!(
            api_key_mode_from_help("--api-key <KEY>"),
            ApiKeyMode::Argument
        );
    }

    #[test]
    fn api_key_help_probe_rejects_unsuccessful_empty_output() {
        let error = api_key_mode_from_probe(false, "")
            .expect_err("failed capability probe must abort startup");
        assert_eq!(
            error.to_string(),
            "API-key capability probe exited unsuccessfully"
        );
    }

    #[test]
    fn api_key_help_probe_uses_successful_output_for_key_mode() {
        assert_eq!(
            api_key_mode_from_probe(true, "LLAMA_API_KEY env var supported")
                .expect("successful environment probe"),
            ApiKeyMode::Environment
        );
        assert_eq!(
            api_key_mode_from_probe(true, "--api-key <KEY>").expect("successful argument probe"),
            ApiKeyMode::Argument
        );
    }

    #[test]
    fn random_keys_are_long_and_different() {
        let a = random_key().expect("secure random key");
        let b = random_key().expect("secure random key");
        assert!(a.len() >= 64);
        assert_ne!(a, b);
    }

    #[test]
    fn random_key_propagates_entropy_failures() {
        let result = random_key_with(|_| Err(io::Error::other("entropy source unavailable")));

        assert_eq!(
            result
                .expect_err("entropy failure must not create a key")
                .to_string(),
            "entropy source unavailable"
        );
    }

    #[test]
    fn loopback_status_parses_health_responses() {
        for (code, line) in [
            (200, "HTTP/1.1 200 OK"),
            (503, "HTTP/1.1 503 Service Unavailable"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").expect("test listener");
            let port = listener.local_addr().expect("listener address").port();
            let thread = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("test connection");
                let mut buf = [0u8; 256];
                let _ = stream.read(&mut buf);
                let _ = write!(stream, "{line}\r\nContent-Length: 0\r\n\r\n");
                thread::sleep(Duration::from_millis(20));
            });
            assert_eq!(
                loopback_status(port, "/health", Duration::from_secs(2)).expect("status"),
                code
            );
            thread.join().expect("test thread");
        }
    }

    #[test]
    fn loopback_status_accumulates_fragmented_status_line() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener");
        let port = listener.local_addr().expect("listener address").port();
        let thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("test connection");
            let mut request = [0u8; 256];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 2")
                .expect("write first status fragment");
            thread::sleep(Duration::from_millis(20));
            stream
                .write_all(b"00 OK\r\nContent-Length: 0\r\n\r\n")
                .expect("write remaining response");
        });

        assert_eq!(
            loopback_status(port, "/health", Duration::from_secs(2)).expect("status"),
            200
        );
        thread.join().expect("test thread");
    }

    #[test]
    fn loopback_status_enforces_a_total_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener");
        let port = listener.local_addr().expect("listener address").port();
        let thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("test connection");
            let mut request = [0u8; 256];
            let _ = stream.read(&mut request);
            for fragment in [b"HTTP/1.1 ".as_slice(), b"200 ", b"OK\r\n"] {
                thread::sleep(Duration::from_millis(70));
                if stream.write_all(fragment).is_err() {
                    break;
                }
            }
        });

        let error = loopback_status(port, "/health", Duration::from_millis(150))
            .expect_err("slow response must time out");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        thread.join().expect("test thread");
    }

    #[test]
    fn loopback_status_rejects_an_oversized_status_line() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener");
        let port = listener.local_addr().expect("listener address").port();
        let thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("test connection");
            let mut request = [0u8; 256];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(&vec![b'x'; 1025]);
            thread::sleep(Duration::from_millis(20));
        });

        let error = loopback_status(port, "/health", Duration::from_secs(2))
            .expect_err("oversized status line must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        thread.join().expect("test thread");
    }

    #[test]
    fn health_check_normalizes_socket_timeout_errors() {
        assert_eq!(
            normalize_timeout_error(io::Error::from(io::ErrorKind::WouldBlock)).kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            normalize_timeout_error(io::Error::from(io::ErrorKind::TimedOut)).kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            normalize_timeout_error(io::Error::from(io::ErrorKind::ConnectionReset)).kind(),
            io::ErrorKind::ConnectionReset
        );
    }

    #[test]
    fn api_key_help_probe_has_a_deadline() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "exec sleep 30"]);
            command
        };

        let started = Instant::now();
        let error = bounded_output(&mut command, Duration::from_millis(100))
            .expect_err("unresponsive capability probe must time out");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn api_key_help_probe_rejects_excessive_output() {
        let error = read_probe_pipe(&vec![b'x'; 64 * 1024 + 1][..])
            .expect_err("oversized help output must not select a key mode");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
