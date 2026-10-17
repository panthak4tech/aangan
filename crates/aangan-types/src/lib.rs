use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub schema_version: u32,
    pub os: OsInfo,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub gpus: Vec<GpuInfo>,
    pub disks: Vec<DiskInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsInfo {
    pub name: String,
    pub version: String,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfo {
    pub brand: String,
    pub physical_cores: u32,
    pub logical_cores: u32,
    /// e.g. "avx2", "fma", "avx512f", "neon"
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
    /// Measured multi-threaded read bandwidth in GB/s (decimal), if measured.
    pub read_bandwidth_gbps: Option<f64>,
    /// "measured" | "skipped" | "unavailable"
    pub bandwidth_source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

impl GpuVendor {
    pub fn from_pci_vendor_id(id: u32) -> Self {
        match id {
            0x10DE => GpuVendor::Nvidia,
            0x1002 | 0x1022 => GpuVendor::Amd,
            0x8086 => GpuVendor::Intel,
            _ => GpuVendor::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub name: String,
    pub vendor: GpuVendor,
    pub dedicated_vram_bytes: u64,
    pub shared_memory_bytes: u64,
    /// Heuristic: integrated GPUs share system RAM.
    pub is_integrated: bool,
    /// Memory bandwidth in GB/s if known (NVIDIA via NVML estimate).
    pub bandwidth_gbps: Option<f64>,
    /// "nvml-estimate" | "unknown"
    pub bandwidth_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub mount: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::GpuVendor;

    #[test]
    fn maps_pci_vendor_ids() {
        assert_eq!(GpuVendor::from_pci_vendor_id(0x10DE), GpuVendor::Nvidia);
        assert_eq!(GpuVendor::from_pci_vendor_id(0x1002), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_pci_vendor_id(0x1022), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_pci_vendor_id(0x8086), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_pci_vendor_id(0x1234), GpuVendor::Other);
    }

    #[test]
    fn serializes_gpu_vendor_as_lowercase() {
        assert_eq!(
            serde_json::to_string(&GpuVendor::Nvidia).unwrap(),
            "\"nvidia\""
        );
        assert_eq!(serde_json::to_string(&GpuVendor::Amd).unwrap(), "\"amd\"");
        assert_eq!(
            serde_json::to_string(&GpuVendor::Intel).unwrap(),
            "\"intel\""
        );
        assert_eq!(
            serde_json::to_string(&GpuVendor::Other).unwrap(),
            "\"other\""
        );
    }
}
