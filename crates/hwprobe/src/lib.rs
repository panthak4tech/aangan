mod bandwidth;
mod gpu;

use aangan_types::{CpuInfo, DiskInfo, HardwareProfile, MemoryInfo, OsInfo, SCHEMA_VERSION};
use sysinfo::{Disks, System};

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

pub fn probe(opts: &ProbeOptions) -> HardwareProfile {
    let sys = System::new_all();
    let cpus = sys.cpus();

    let (read_bandwidth_gbps, bandwidth_source) = if opts.measure_bandwidth {
        match bandwidth::measure_read_gbps() {
            Some(value) => (Some(value), "measured"),
            None => (None, "unavailable"),
        }
    } else {
        (None, "skipped")
    };

    let disks = Disks::new_with_refreshed_list();

    HardwareProfile {
        schema_version: SCHEMA_VERSION,
        os: OsInfo {
            name: System::name().unwrap_or_else(|| "unknown".into()),
            version: System::long_os_version()
                .or_else(System::os_version)
                .unwrap_or_default(),
            arch: std::env::consts::ARCH.to_string(),
        },
        cpu: CpuInfo {
            brand: cpus
                .first()
                .map(|cpu| cpu.brand().trim().to_string())
                .unwrap_or_default(),
            physical_cores: System::physical_core_count().unwrap_or(cpus.len()) as u32,
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
            .list()
            .iter()
            .map(|disk| DiskInfo {
                mount: disk.mount_point().display().to_string(),
                total_bytes: disk.total_space(),
                available_bytes: disk.available_space(),
            })
            .collect(),
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
    use super::{probe, ProbeOptions};
    use aangan_types::SCHEMA_VERSION;

    #[test]
    fn probes_hardware_and_respects_skipped_bandwidth_option() {
        let profile = probe(&ProbeOptions {
            measure_bandwidth: false,
        });

        assert_eq!(profile.schema_version, SCHEMA_VERSION);
        assert_eq!(profile.memory.read_bandwidth_gbps, None);
        assert_eq!(profile.memory.bandwidth_source, "skipped");
        assert!(profile.cpu.logical_cores > 0);
        assert!(!profile.os.name.is_empty());
    }
}
