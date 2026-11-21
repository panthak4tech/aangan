mod bandwidth;
mod gpu;

use aangan_types::{CpuInfo, DiskInfo, HardwareProfile, MemoryInfo, OsInfo, SCHEMA_VERSION};
use sysinfo::{Disks, System};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeHwFacts {
    pub nvidia_cuda_driver: Option<u32>,
    pub has_discrete_gpu: bool,
}

#[derive(Debug, Clone)]
pub struct ProbeOptions {
    /// Run a ~2 second memory-read benchmark. Recommended: it replaces guesses.
    pub measure_bandwidth: bool,
}

impl Default for ProbeOptions {
    fn default() -> Self {
        Self {
            measure_bandwidth: true,
        }
    }
}

pub fn probe(opts: &ProbeOptions) -> Result<HardwareProfile, sysinfo::Error> {
    let sys = System::new_all()?;
    let cpus = sys.cpus();

    let (read_bandwidth_gbps, bandwidth_source) = if opts.measure_bandwidth {
        match bandwidth::measure_read_gbps() {
            Some(value) => (Some(value), "measured"),
            None => (None, "unavailable"),
        }
    } else {
        (None, "skipped")
    };

    let disks = Disks::new_with_refreshed_list()?;

    Ok(HardwareProfile {
        schema_version: SCHEMA_VERSION,
        os: OsInfo {
            name: System::name()?,
            version: System::long_os_version().or_else(|_| System::os_version())?,
            arch: std::env::consts::ARCH.to_string(),
        },
        cpu: CpuInfo {
            brand: cpus
                .first()
                .map(|cpu| cpu.brand().trim().to_string())
                .unwrap_or_default(),
            physical_cores: System::physical_core_count()? as u32,
            logical_cores: cpus.len() as u32,
            features: cpu_features(),
        },
        memory: MemoryInfo {
            total_bytes: sys.total_memory(),
            available_bytes: sys.available_memory(),
            read_bandwidth_gbps,
            bandwidth_source: bandwidth_source.to_string(),
        },
        gpus: gpu::probe_gpus(),
        disks: disks
            .iter()
            .map(|disk| DiskInfo {
                mount: disk.mount_point().display().to_string(),
                total_bytes: disk.total_space(),
                available_bytes: disk.available_space(),
            })
            .collect(),
    })
}

pub fn runtime_facts() -> RuntimeHwFacts {
    let gpus = gpu::probe_gpus();
    runtime_facts_from(gpu::nvidia_cuda_driver_version(), &gpus)
}

fn runtime_facts_from(
    nvidia_cuda_driver: Option<u32>,
    gpus: &[aangan_types::GpuInfo],
) -> RuntimeHwFacts {
    RuntimeHwFacts {
        nvidia_cuda_driver,
        has_discrete_gpu: gpus.iter().any(|gpu| !gpu.is_integrated),
    }
}

fn cpu_features() -> Vec<String> {
    #[allow(unused_mut)]
    let mut features: Vec<String> = Vec::new();
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") {
            features.push("avx2".into());
        }
        if std::is_x86_feature_detected!("fma") {
            features.push("fma".into());
        }
        if std::is_x86_feature_detected!("avx512f") {
            features.push("avx512f".into());
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
        if std::arch::is_aarch64_feature_detected!("neon") {
            features.push("neon".into());
        }
    }
    features
}

#[cfg(test)]
mod tests {
    use super::{probe, runtime_facts_from, ProbeOptions};
    use aangan_types::{GpuInfo, GpuVendor, SCHEMA_VERSION};

    #[test]
    fn runtime_facts_use_injected_nvidia_and_discrete_gpu_values() {
        let integrated = GpuInfo {
            name: "Integrated".into(),
            vendor: GpuVendor::Intel,
            dedicated_vram_bytes: 0,
            shared_memory_bytes: 0,
            is_integrated: true,
            bandwidth_gbps: None,
            bandwidth_source: "unknown".into(),
        };
        let discrete = GpuInfo {
            name: "Discrete".into(),
            vendor: GpuVendor::Nvidia,
            dedicated_vram_bytes: 8,
            shared_memory_bytes: 0,
            is_integrated: false,
            bandwidth_gbps: None,
            bandwidth_source: "unknown".into(),
        };

        assert_eq!(
            runtime_facts_from(Some(12040), &[integrated.clone(), discrete]),
            super::RuntimeHwFacts {
                nvidia_cuda_driver: Some(12040),
                has_discrete_gpu: true,
            }
        );
        assert_eq!(
            runtime_facts_from(None, &[integrated]),
            super::RuntimeHwFacts {
                nvidia_cuda_driver: None,
                has_discrete_gpu: false,
            }
        );
    }

    #[test]
    fn probes_hardware_and_respects_skipped_bandwidth_option() {
        let profile = probe(&ProbeOptions {
            measure_bandwidth: false,
        })
        .expect("hardware probe should succeed");

        assert_eq!(profile.schema_version, SCHEMA_VERSION);
        assert_eq!(profile.memory.read_bandwidth_gbps, None);
        assert_eq!(profile.memory.bandwidth_source, "skipped");
        assert!(profile.cpu.logical_cores > 0);
        assert!(!profile.os.name.is_empty());
    }
}
