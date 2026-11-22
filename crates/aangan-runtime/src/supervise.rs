use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub fn free_loopback_port() -> io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

pub fn random_key() -> String {
    let mut bytes = [0u8; 32];
    match getrandom::fill(&mut bytes) {
        Ok(()) => hex::encode(bytes),
        Err(_) => {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            hex::encode(format!("{nanos}:{}", std::process::id()).as_bytes())
        }
    }
}

pub fn loopback_status(port: u16, path: &str, timeout: Duration) -> io::Result<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )?;
    let mut buf = [0u8; 128];
    let read = stream.read(&mut buf)?;
    let head = std::str::from_utf8(&buf[..read]).unwrap_or("");
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

pub fn api_key_mode(exe: &std::path::Path) -> io::Result<ApiKeyMode> {
    let mut command = std::process::Command::new(exe);
    command.arg("--help").stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
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
    use std::thread;

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
        assert!(!is_blocked_env("SystemRoot"));
        assert!(!is_blocked_env("PATH"));
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
        let a = random_key();
        let b = random_key();
        assert!(a.len() >= 64);
        assert_ne!(a, b);
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
}
