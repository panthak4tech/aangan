# Runtime Security Model

Aangan runs downloaded llama.cpp only on loopback at `127.0.0.1` on a random port.
The runtime receives a random per-session API key; model and runtime processes do not
receive an API key on the command line. Aangan does not expose the server beyond the PC.

On Windows, the runtime process is assigned to a Job Object configured with
`KILL_ON_JOB_CLOSE`. The application stops the process tree on its Stop action and the
Job Object handle closes automatically when Aangan exits or crashes.

Aangan removes inherited `LLAMA_*`, `HF_*`, `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY`
environment variables before starting the runtime. Runtime output is redacted before it
enters the log buffer or diagnostics. The runtime is never given network download flags.

Other local programs running under the same Windows account may be able to inspect
process memory or system activity. That is outside Aangan's threat model. Loopback binding
does not make the runtime endpoint invisible to other processes on the same account.
