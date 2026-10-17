# How Aangan estimates fit and speed

- Weights memory = the GGUF file size.
- KV cache = 2 x layers x KV heads x head dimension x context x 2 bytes (fp16).
- Overhead = a fixed allowance for runtime buffers (default 768 MiB).
- GPU budget = 90% of dedicated VRAM; RAM budget = 70% of installed RAM.
- Decode speed is approximately memory bandwidth x efficiency / bytes read per token (approximately model size for dense models; active parameters only for mixture-of-experts).
- CPU bandwidth is measured with a multi-threaded read over 256 MiB. NVIDIA GPU bandwidth is estimated from NVML bus width and memory clock; otherwise it is assumed.
- Partial offload adds per-layer times for GPU and CPU layers, then applies a penalty.
- Fit: Great >= 25 tok/s, Good >= 12, Slow >= 5, otherwise Too slow; "Won't fit" if memory is insufficient.

All constants are in [`Tunables`](../crates/fitcalc/src/estimate.rs). Estimates are not benchmarks.
