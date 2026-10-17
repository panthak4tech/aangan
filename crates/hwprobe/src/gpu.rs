use aangan_types::{GpuInfo, GpuVendor};

const GIB: u64 = 1024 * 1024 * 1024;

pub fn probe_gpus() -> Vec<GpuInfo> {
    let mut gpus = platform::list_adapters();
    for gpu in &mut gpus {
        gpu.is_integrated =
            gpu.vendor != GpuVendor::Nvidia && gpu.dedicated_vram_bytes < GIB + GIB / 2;
    }
    gpus
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
    pub fn list_adapters() -> Vec<GpuInfo> {
        let mut nvml_pool = nvml_gpus();
        let mut gpus = Vec::new();
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
                return gpus;
            };
            let mut index = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(index) {
                index += 1;
                let Ok(description) = adapter.GetDesc1() else {
                    continue;
                };
                let software = (description.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32)) != 0
                    || description.VendorId == 0x1414;
                if software {
                    continue;
                }

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
                if vendor == GpuVendor::Nvidia {
                    if let Some(nvml_gpu) = take_match(&name, &mut nvml_pool) {
                        info.dedicated_vram_bytes = nvml_gpu.vram_total;
                        if nvml_gpu.bandwidth_gbps.is_some() {
                            info.bandwidth_gbps = nvml_gpu.bandwidth_gbps;
                            info.bandwidth_source = "nvml-estimate".into();
                        }
                    }
                }
                gpus.push(info);
            }
        }
        gpus
    }
}

#[cfg(not(windows))]
mod platform {
    use aangan_types::GpuInfo;

    pub fn list_adapters() -> Vec<GpuInfo> {
        Vec::new()
    }
}
