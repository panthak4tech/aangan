use crate::model::ModelSpec;
use aangan_types::{GpuInfo, HardwareProfile};
use serde::{Deserialize, Serialize};

/// Ordered worst to best, so `fit >= Fit::Good` works.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fit {
    WontFit,
    TooSlow,
    Slow,
    Good,
    Great,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Placement {
    FullGpu,
    PartialGpu { gpu_layers: u32, total_layers: u32 },
    CpuOnly,
    NoFit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    /// Computed from formulas (M1). "Measured" arrives with the on-device benchmark (M4).
    Estimated,
    Measured,
}

#[derive(Debug, Clone)]
pub struct Tunables {
    pub overhead_bytes: u64,
    pub gpu_vram_fraction: f64,
    pub ram_budget_fraction: f64,
    pub gpu_efficiency: f64,
    pub cpu_efficiency_measured: f64,
    pub cpu_efficiency_assumed: f64,
    pub assumed_cpu_bandwidth_gbps: f64,
    pub assumed_gpu_bandwidth_gbps: f64,
    pub partial_offload_penalty: f64,
    pub great_tps: f64,
    pub good_tps: f64,
    pub slow_tps: f64,
}

impl Default for Tunables {
    fn default() -> Self {
        Self {
            overhead_bytes: 768 * 1024 * 1024,
            gpu_vram_fraction: 0.90,
            ram_budget_fraction: 0.70,
            gpu_efficiency: 0.65,
            cpu_efficiency_measured: 0.85,
            cpu_efficiency_assumed: 0.55,
            assumed_cpu_bandwidth_gbps: 25.0,
            assumed_gpu_bandwidth_gbps: 200.0,
            partial_offload_penalty: 0.85,
            great_tps: 25.0,
            good_tps: 12.0,
            slow_tps: 5.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Estimate {
    pub model_id: String,
    pub placement: Placement,
    pub fit: Fit,
    pub decode_tps: f64,
    pub memory_required_bytes: u64,
    pub weights_bytes: u64,
    pub kv_cache_bytes: u64,
    pub overhead_bytes: u64,
    pub context: u32,
    pub confidence: Confidence,
    pub reasons: Vec<String>,
}

/// KV cache = 2 (K and V) * layers * kv_heads * head_dim * context * 2 bytes (fp16).
pub fn kv_cache_bytes(model: &ModelSpec, context: u32) -> u64 {
    2 * model.n_layers as u64 * model.n_kv_heads as u64 * model.head_dim as u64 * context as u64 * 2
}

fn best_gpu(profile: &HardwareProfile) -> Option<&GpuInfo> {
    profile
        .gpus
        .iter()
        .filter(|gpu| !gpu.is_integrated)
        .max_by_key(|gpu| gpu.dedicated_vram_bytes)
}

fn gb(bytes: u64) -> f64 {
    bytes as f64 / 1e9
}

pub fn estimate(
    profile: &HardwareProfile,
    model: &ModelSpec,
    context: u32,
    tunables: &Tunables,
) -> Estimate {
    let context = context.clamp(512, model.context_max.max(512));
    let weights = model.file_size_bytes;
    let kv = kv_cache_bytes(model, context);
    let total = weights + kv + tunables.overhead_bytes;

    let active_ratio = (model.active_params_b / model.params_b).clamp(0.05, 1.0);
    let token_gb = weights as f64 * active_ratio / 1e9;

    let (cpu_bandwidth, cpu_efficiency, cpu_note) = match profile.memory.read_bandwidth_gbps {
        Some(bandwidth) => (bandwidth, tunables.cpu_efficiency_measured, "measured"),
        None => (
            tunables.assumed_cpu_bandwidth_gbps,
            tunables.cpu_efficiency_assumed,
            "assumed",
        ),
    };
    let ram_budget = (profile.memory.total_bytes as f64 * tunables.ram_budget_fraction) as u64;
    let mut reasons: Vec<String> = Vec::new();

    let (placement, decode_tps) = 'place: {
        if let Some(gpu) = best_gpu(profile) {
            let vram = (gpu.dedicated_vram_bytes as f64 * tunables.gpu_vram_fraction) as u64;
            let (gpu_bandwidth, gpu_note) = match gpu.bandwidth_gbps {
                Some(bandwidth) => (bandwidth, "from GPU specs"),
                None => (tunables.assumed_gpu_bandwidth_gbps, "assumed"),
            };

            if total <= vram {
                reasons.push(format!(
                    "Fits entirely in GPU memory ({:.1} GB needed of {:.1} GB usable).",
                    gb(total),
                    gb(vram)
                ));
                reasons.push(format!(
                    "GPU memory speed {:.0} GB/s ({gpu_note}).",
                    gpu_bandwidth
                ));
                break 'place (
                    Placement::FullGpu,
                    gpu_bandwidth * tunables.gpu_efficiency / token_gb,
                );
            }

            let per_layer = (weights + kv) as f64 / model.n_layers as f64;
            let budget = vram.saturating_sub(tunables.overhead_bytes) as f64;
            let gpu_layers = ((budget / per_layer).floor() as u32).min(model.n_layers);
            if gpu_layers > 0 && gpu_layers < model.n_layers {
                let cpu_layers = model.n_layers - gpu_layers;
                let cpu_memory = (per_layer * cpu_layers as f64) as u64 + tunables.overhead_bytes;
                if cpu_memory <= ram_budget {
                    let gpu_fraction = gpu_layers as f64 / model.n_layers as f64;
                    let seconds = token_gb * gpu_fraction
                        / (gpu_bandwidth * tunables.gpu_efficiency)
                        + token_gb * (1.0 - gpu_fraction) / (cpu_bandwidth * cpu_efficiency);
                    reasons.push(format!(
                        "Too big for GPU memory alone; {gpu_layers} of {} layers on GPU, the rest on CPU.",
                        model.n_layers
                    ));
                    reasons.push(format!(
                        "Mixed GPU/CPU runs slower than all-GPU. RAM speed {:.0} GB/s ({cpu_note}).",
                        cpu_bandwidth
                    ));
                    break 'place (
                        Placement::PartialGpu {
                            gpu_layers,
                            total_layers: model.n_layers,
                        },
                        tunables.partial_offload_penalty / seconds,
                    );
                }
            }
        }

        if total <= ram_budget {
            reasons.push(format!(
                "Runs on CPU using {:.1} GB of about {:.1} GB usable RAM.",
                gb(total),
                gb(ram_budget)
            ));
            reasons.push(format!(
                "RAM read speed {:.0} GB/s ({cpu_note}).",
                cpu_bandwidth
            ));
            break 'place (
                Placement::CpuOnly,
                cpu_bandwidth * cpu_efficiency / token_gb,
            );
        }

        reasons.push(format!(
            "Needs about {:.1} GB but only about {:.1} GB of RAM is usable. Try a smaller model or shorter context.",
            gb(total),
            gb(ram_budget)
        ));
        (Placement::NoFit, 0.0)
    };

    let fit = match placement {
        Placement::NoFit => Fit::WontFit,
        _ if decode_tps >= tunables.great_tps => Fit::Great,
        _ if decode_tps >= tunables.good_tps => Fit::Good,
        _ if decode_tps >= tunables.slow_tps => Fit::Slow,
        _ => Fit::TooSlow,
    };

    Estimate {
        model_id: model.id.clone(),
        placement,
        fit,
        decode_tps,
        memory_required_bytes: total,
        weights_bytes: weights,
        kv_cache_bytes: kv,
        overhead_bytes: tunables.overhead_bytes,
        context,
        confidence: Confidence::Estimated,
        reasons,
    }
}
