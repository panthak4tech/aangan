use std::{
    env,
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
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
        let read = stream.read(&mut buf)?;
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

pub fn api_key_mode(exe: &Path) -> io::Result<ApiKeyMode> {
    let mut command = Command::new(exe);
    prepare_api_key_help_command(&mut command, env::vars_os().map(|(name, _)| name));
    let output = command.output()?;
    let help = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(api_key_mode_from_help(&help))
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
        });

        let error = loopback_status(port, "/health", Duration::from_secs(2))
            .expect_err("oversized status line must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        thread.join().expect("test thread");
    }
}
