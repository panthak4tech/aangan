use aangan_types::{GpuInfo, GpuVendor};

const GIB: u64 = 1024 * 1024 * 1024;
const MIN_DISCRETE_VRAM_BYTES: u64 = GIB + GIB / 2;
const SOFTWARE_ADAPTER_NAME: &str = "microsoft basic render driver";

struct AdapterCandidate {
    info: GpuInfo,
    nvml_present: bool,
    software: bool,
}

pub fn probe_gpus() -> Vec<GpuInfo> {
    classify_adapters(platform::list_adapters())
}

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

            adapter.info.is_integrated = !adapter.nvml_present
                && adapter.info.dedicated_vram_bytes < MIN_DISCRETE_VRAM_BYTES;
            Some(adapter.info)
        })
        .collect()
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
    use super::{classify_adapters, AdapterCandidate, MIN_DISCRETE_VRAM_BYTES};
    use aangan_types::{GpuInfo, GpuVendor};

    fn candidate(
        name: &str,
        vendor: GpuVendor,
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
            nvml_present,
            software,
        }
    }

    #[test]
    fn nvml_presence_classifies_adapter_as_discrete() {
        let gpus = classify_adapters(vec![candidate(
            "NVIDIA GPU",
            GpuVendor::Nvidia,
            512 * 1024 * 1024,
            true,
            false,
        )]);

        assert_eq!(gpus.len(), 1);
        assert!(!gpus[0].is_integrated);
    }

    #[test]
    fn low_dedicated_memory_without_nvml_is_integrated() {
        let gpus = classify_adapters(vec![candidate(
            "Intel Graphics",
            GpuVendor::Intel,
            1024 * 1024 * 1024,
            false,
            false,
        )]);

        assert_eq!(gpus.len(), 1);
        assert!(gpus[0].is_integrated);
    }

    #[test]
    fn adapters_at_the_discrete_memory_threshold_are_not_integrated() {
        let gpus = classify_adapters(vec![candidate(
            "Discrete GPU",
            GpuVendor::Other,
            MIN_DISCRETE_VRAM_BYTES,
            false,
            false,
        )]);

        assert_eq!(gpus.len(), 1);
        assert!(!gpus[0].is_integrated);
    }

    #[test]
    fn software_adapters_are_filtered() {
        let gpus = classify_adapters(vec![
            candidate(
                "Microsoft Basic Render Driver",
                GpuVendor::Other,
                0,
                false,
                false,
            ),
            candidate("Software Rasterizer", GpuVendor::Other, 0, false, true),
            candidate("Intel Graphics", GpuVendor::Intel, 0, false, false),
        ]);

        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, "Intel Graphics");
    }

    #[test]
    fn discrete_adapter_is_used_when_integrated_and_discrete_are_present() {
        let gpus = classify_adapters(vec![
            candidate("Intel Graphics", GpuVendor::Intel, 0, false, false),
            candidate(
                "NVIDIA GPU",
                GpuVendor::Nvidia,
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
