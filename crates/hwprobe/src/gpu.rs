use aangan_types::{GpuInfo, GpuVendor};

const SOFTWARE_ADAPTER_NAME: &str = "microsoft basic render driver";
// Known integrated GPU PCI IDs; add entries when supporting new adapter families.
const AMD_INTEGRATED_DEVICE_IDS: &[u32] = &[
    0x15BF, 0x15D8, 0x15DD, 0x15E7, 0x1636, 0x1638, 0x164C, 0x164E, 0x1681,
];
const INTEL_INTEGRATED_DEVICE_IDS: &[u32] = &[
    0x1902, 0x1912, 0x1916, 0x1926, 0x1932, 0x3E92, 0x3EA0, 0x3EA5, 0x4680, 0x4682, 0x46A6, 0x5912,
    0x5916, 0x5926, 0x7D55, 0x8A52, 0x8A5A, 0x9A40, 0x9A49, 0x9A59, 0x9A60, 0xA780, 0xA7A0,
];

struct AdapterCandidate {
    info: GpuInfo,
    device_id: u32,
    nvml_present: bool,
    software: bool,
}

/// Returns detected hardware adapters with known integrated devices classified by PCI ID.
pub fn probe_gpus() -> Vec<GpuInfo> {
    classify_adapters(platform::list_adapters())
}

/// Filters software adapters and applies the known integrated-device ID lists.
fn classify_adapters(adapters: Vec<AdapterCandidate>) -> Vec<GpuInfo> {
    adapters
        .into_iter()
        .filter_map(|mut adapter| {
            if adapter.software
                || adapter
                    .info
                    .name
                    .to_lowercase()
                    .contains(SOFTWARE_ADAPTER_NAME)
            {
                return None;
            }

            adapter.info.is_integrated =
                is_integrated_adapter(adapter.info.vendor, adapter.device_id, adapter.nvml_present);
            Some(adapter.info)
        })
        .collect()
}

/// Returns true only for known integrated PCI device IDs; unknown IDs default to discrete.
fn is_integrated_adapter(vendor: GpuVendor, device_id: u32, nvml_present: bool) -> bool {
    if nvml_present {
        return false;
    }

    match vendor {
        GpuVendor::Amd => AMD_INTEGRATED_DEVICE_IDS.contains(&device_id),
        GpuVendor::Intel => INTEL_INTEGRATED_DEVICE_IDS.contains(&device_id),
        GpuVendor::Nvidia | GpuVendor::Other => false,
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use nvml_wrapper::{enum_wrappers::device::Clock, Nvml};
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    struct NvmlGpu {
        name: String,
        vram_total: u64,
        bandwidth_gbps: Option<f64>,
    }

    /// Returns the NVIDIA GPUs reported by NVML, or an empty list when it is unavailable.
    fn nvml_gpus() -> Vec<NvmlGpu> {
        let Ok(nvml) = Nvml::init() else {
            return Vec::new();
        };
        let Ok(count) = nvml.device_count() else {
            return Vec::new();
        };
        (0..count)
            .filter_map(|index| {
                let device = nvml.device_by_index(index).ok()?;
                let name = device.name().ok()?;
                let vram_total = device.memory_info().ok()?.total;
                let bandwidth_gbps = match (
                    device.memory_bus_width().ok(),
                    device.max_clock_info(Clock::Memory).ok(),
                ) {
                    (Some(bits), Some(mhz)) => Some(bits as f64 / 8.0 * mhz as f64 * 2.0 / 1000.0),
                    _ => None,
                };
                Some(NvmlGpu {
                    name,
                    vram_total,
                    bandwidth_gbps,
                })
            })
            .collect()
    }

    /// Consumes the matching NVML entry, falling back to the first remaining device.
    fn take_match(name: &str, pool: &mut Vec<NvmlGpu>) -> Option<NvmlGpu> {
        let normalized_name = name.to_lowercase();
        let index = pool
            .iter()
            .position(|gpu| {
                let gpu_name = gpu.name.to_lowercase();
                normalized_name.contains(&gpu_name) || gpu_name.contains(&normalized_name)
            })
            .or(if pool.is_empty() { None } else { Some(0) })?;
        Some(pool.remove(index))
    }

    /// DXGI lists every GPU on Windows and avoids WMI's 32-bit VRAM limit.
    #[allow(unused_unsafe)]
    pub fn list_adapters() -> Vec<AdapterCandidate> {
        let mut nvml_pool = nvml_gpus();
        let mut adapters = Vec::new();
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
                return adapters;
            };
            let mut index = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(index) {
                index += 1;
                let Ok(description) = adapter.GetDesc1() else {
                    continue;
                };
                let software = (description.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32)) != 0
                    || description.VendorId == 0x1414;

                let name = String::from_utf16_lossy(&description.Description)
                    .trim_end_matches('\0')
                    .trim()
                    .to_string();
                let vendor = GpuVendor::from_pci_vendor_id(description.VendorId);
                let mut info = GpuInfo {
                    name: name.clone(),
                    vendor,
                    dedicated_vram_bytes: description.DedicatedVideoMemory as u64,
                    shared_memory_bytes: description.SharedSystemMemory as u64,
                    is_integrated: false,
                    bandwidth_gbps: None,
                    bandwidth_source: "unknown".into(),
                };
                let nvml_gpu = if !software && vendor == GpuVendor::Nvidia {
                    take_match(&name, &mut nvml_pool)
                } else {
                    None
                };
                if let Some(nvml_gpu) = &nvml_gpu {
                    info.dedicated_vram_bytes = nvml_gpu.vram_total;
                    if nvml_gpu.bandwidth_gbps.is_some() {
                        info.bandwidth_gbps = nvml_gpu.bandwidth_gbps;
                        info.bandwidth_source = "nvml-estimate".into();
                    }
                }
                adapters.push(AdapterCandidate {
                    info,
                    device_id: description.DeviceId,
                    nvml_present: nvml_gpu.is_some(),
                    software,
                });
            }
        }
        adapters
    }
}

#[cfg(not(windows))]
mod platform {
    use super::AdapterCandidate;

    pub fn list_adapters() -> Vec<AdapterCandidate> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_adapters, AdapterCandidate};
    use aangan_types::{GpuInfo, GpuVendor};

    /// Builds a test adapter with an explicit PCI identity and memory profile.
    fn candidate(
        name: &str,
        vendor: GpuVendor,
        device_id: u32,
        dedicated_vram_bytes: u64,
        nvml_present: bool,
        software: bool,
    ) -> AdapterCandidate {
        AdapterCandidate {
            info: GpuInfo {
                name: name.to_string(),
                vendor,
                dedicated_vram_bytes,
                shared_memory_bytes: 8 * 1024 * 1024 * 1024,
                is_integrated: false,
                bandwidth_gbps: None,
                bandwidth_source: "unknown".into(),
            },
            device_id,
            nvml_present,
            software,
        }
    }

    #[test]
    fn nvml_presence_classifies_adapter_as_discrete() {
        let gpus = classify_adapters(vec![candidate(
            "NVIDIA GPU",
            GpuVendor::Nvidia,
            0x2484,
            512 * 1024 * 1024,
            true,
            false,
        )]);

        assert_eq!(gpus.len(), 1);
        assert!(!gpus[0].is_integrated);
    }

    #[test]
    fn large_memory_amd_integrated_adapter_is_classified_by_device_id() {
        let gpus = classify_adapters(vec![candidate(
            "AMD Radeon 780M Graphics",
            GpuVendor::Amd,
            0x15BF,
            8 * 1024 * 1024 * 1024,
            false,
            false,
        )]);

        assert_eq!(gpus.len(), 1);
        assert!(gpus[0].is_integrated);
    }

    #[test]
    fn low_memory_discrete_adapter_is_classified_by_device_id() {
        let gpus = classify_adapters(vec![candidate(
            "AMD Radeon RX 580",
            GpuVendor::Amd,
            0x67DF,
            512 * 1024 * 1024,
            false,
            false,
        )]);

        assert_eq!(gpus.len(), 1);
        assert!(!gpus[0].is_integrated);
    }

    #[test]
    fn unrecognized_device_ids_default_to_discrete() {
        let gpus = classify_adapters(vec![candidate(
            "Unknown GPU",
            GpuVendor::Other,
            0xFFFF,
            512 * 1024 * 1024,
            false,
            false,
        )]);

        assert_eq!(gpus.len(), 1);
        assert!(!gpus[0].is_integrated);
    }

    #[test]
    fn intel_integrated_adapter_is_classified_by_device_id() {
        let gpus = classify_adapters(vec![candidate(
            "Intel Iris Xe Graphics",
            GpuVendor::Intel,
            0x9A49,
            512 * 1024 * 1024,
            false,
            false,
        )]);

        assert_eq!(gpus.len(), 1);
        assert!(gpus[0].is_integrated);
    }

    #[test]
    fn software_adapters_are_filtered() {
        let gpus = classify_adapters(vec![
            candidate(
                "Microsoft Basic Render Driver",
                GpuVendor::Other,
                0,
                0,
                false,
                false,
            ),
            candidate("Software Rasterizer", GpuVendor::Other, 0, 0, false, true),
            candidate("Intel Graphics", GpuVendor::Intel, 0x9A49, 0, false, false),
        ]);

        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, "Intel Graphics");
    }

    #[test]
    fn discrete_adapter_is_used_when_integrated_and_discrete_are_present() {
        let gpus = classify_adapters(vec![
            candidate("Intel Graphics", GpuVendor::Intel, 0x9A49, 0, false, false),
            candidate(
                "NVIDIA GPU",
                GpuVendor::Nvidia,
                0x2484,
                8 * 1024 * 1024 * 1024,
                true,
                false,
            ),
        ]);

        assert_eq!(gpus.len(), 2);
        assert!(gpus[0].is_integrated);
        assert!(!gpus[1].is_integrated);
    }
}
