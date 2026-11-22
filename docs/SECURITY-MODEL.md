# Runtime Security Model

Aangan runs downloaded llama.cpp only on loopback at `127.0.0.1` on a random port.
The runtime receives a cryptographically random, per-session API key. Aangan prefers
the `LLAMA_API_KEY` or `LLAMA_ARG_API_KEY` environment variables when the runtime's help
output advertises support. If the runtime instead advertises only `--api-key`, Aangan
uses that compatibility fallback, which can expose the key to same-user process
inspection. If a help probe fails or times out, startup stops rather than guessing a
key-delivery method. Successful help output that advertises neither option continues
to use the environment-variable method. Aangan does not expose the server beyond the PC.

On Windows, the runtime process is assigned to a Job Object configured with
`KILL_ON_JOB_CLOSE`. The application stops the process tree on its Stop action and the
Job Object handle closes automatically when Aangan exits or crashes.

Aangan removes inherited `LLAMA_*`, `HF_*`, and proxy environment variables before
probing or starting the runtime, while preserving required system variables such as
`PATH` and `SystemRoot`. Runtime output is redacted before it enters the log buffer or
diagnostics. The runtime is never given network download flags.

Other local programs running under the same Windows account may be able to inspect
process memory or system activity. That is outside Aangan's threat model. Loopback binding
does not make the runtime endpoint invisible to other processes on the same account.
