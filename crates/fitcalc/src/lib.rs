mod catalog;
mod estimate;
mod model;
mod recommend;

pub use catalog::{builtin_catalog, parse_catalog};
pub use estimate::{estimate, kv_cache_bytes, Confidence, Estimate, Fit, Placement, Tunables};
pub use model::{License, ModelSpec};
pub use recommend::{recommend, Recommendation};

#[cfg(test)]
mod tests {
    use super::{
        builtin_catalog, estimate, kv_cache_bytes, recommend, Confidence, Fit, License, ModelSpec,
        Placement, Tunables,
    };
    use aangan_types::{
        CpuInfo, GpuInfo, GpuVendor, HardwareProfile, MemoryInfo, OsInfo, SCHEMA_VERSION,
    };

    fn model() -> ModelSpec {
        ModelSpec {
            id: "test-model".into(),
            name: "Test Model".into(),
            family: "Test".into(),
            params_b: 1.0,
            active_params_b: 1.0,
            quant: "Q4_K_M".into(),
            file_size_bytes: 500_000_000,
            n_layers: 24,
            n_kv_heads: 2,
            head_dim: 64,
            context_max: 4096,
            license: License {
                id: "MIT".into(),
                osi_open: true,
                url: String::new(),
            },
            tags: Vec::new(),
            verified: false,
        }
    }

    fn profile() -> HardwareProfile {
        HardwareProfile {
            schema_version: SCHEMA_VERSION,
            os: OsInfo {
                name: "test".into(),
                version: String::new(),
                arch: "x86_64".into(),
            },
            cpu: CpuInfo {
                brand: "test cpu".into(),
                physical_cores: 4,
                logical_cores: 8,
                features: Vec::new(),
            },
            memory: MemoryInfo {
                total_bytes: 16_000_000_000,
                available_bytes: 12_000_000_000,
                read_bandwidth_gbps: None,
                bandwidth_source: "unavailable".into(),
            },
            gpus: Vec::new(),
            disks: Vec::new(),
        }
    }

    #[test]
    fn parses_builtin_catalog() {
        let catalog = builtin_catalog();
        assert_eq!(catalog.len(), 7);
        assert!(catalog.iter().all(|model| !model.verified));
    }

    #[test]
    fn computes_fp16_kv_cache_size() {
        assert_eq!(kv_cache_bytes(&model(), 1024), 12_582_912);
    }

    #[test]
    fn estimates_cpu_placement_and_clamps_context() {
        let result = estimate(&profile(), &model(), 128, &Tunables::default());

        assert_eq!(result.placement, Placement::CpuOnly);
        assert_eq!(result.fit, Fit::Great);
        assert_eq!(result.context, 512);
        assert_eq!(result.confidence, Confidence::Estimated);
        assert_eq!(
            result.memory_required_bytes,
            result.weights_bytes + result.kv_cache_bytes + result.overhead_bytes
        );
    }

    /// Checks CPU bandwidth fit thresholds and rejection when system memory is insufficient.
    #[test]
    fn estimate_classifies_cpu_speed_thresholds_and_memory_failure() {
        let mut hardware = profile();
        for (bandwidth, expected) in [
            (25.0, Fit::Great),
            (12.0, Fit::Good),
            (8.0, Fit::Slow),
            (4.0, Fit::TooSlow),
        ] {
            let tunables = Tunables {
                assumed_cpu_bandwidth_gbps: bandwidth,
                ..Tunables::default()
            };
            let result = estimate(&hardware, &model(), 512, &tunables);
            assert_eq!(result.placement, Placement::CpuOnly);
            assert_eq!(result.fit, expected);
        }

        hardware.memory.total_bytes = 1_000_000_000;
        let result = estimate(&hardware, &model(), 512, &Tunables::default());
        assert_eq!(result.placement, Placement::NoFit);
        assert_eq!(result.fit, Fit::WontFit);
        assert!(result.reasons[0].contains("Try a smaller model"));
    }

    /// Verifies partial GPU offloading retains a positive decode rate and explains the split.
    #[test]
    fn estimate_partially_offloads_when_gpu_memory_cannot_hold_all_layers() {
        let mut hardware = profile();
        hardware.gpus.push(GpuInfo {
            name: "Fixture GPU".into(),
            vendor: GpuVendor::Nvidia,
            dedicated_vram_bytes: 1_200_000_000,
            shared_memory_bytes: 0,
            is_integrated: false,
            bandwidth_gbps: Some(100.0),
            bandwidth_source: "fixture".into(),
        });

        let result = estimate(&hardware, &model(), 512, &Tunables::default());
        assert!(matches!(
            result.placement,
            Placement::PartialGpu {
                gpu_layers,
                total_layers: 24
            } if gpu_layers > 0 && gpu_layers < 24
        ));
        assert!(result.decode_tps > 0.0);
        assert!(result.reasons[0].contains("Too big for GPU memory alone"));
    }

    #[test]
    fn recommendations_rank_by_speed_and_mark_best_fit_and_fastest_separately() {
        let mut largest = model();
        largest.id = "largest".into();
        largest.name = "Largest".into();
        largest.params_b = 2.0;
        largest.active_params_b = 2.0;
        largest.file_size_bytes = 1_000_000_000;

        let mut smaller = model();
        smaller.id = "smaller".into();
        smaller.params_b = 0.5;
        smaller.active_params_b = 0.5;
        smaller.file_size_bytes = 250_000_000;

        let recommendations =
            recommend(&profile(), &[smaller, largest], 2048, &Tunables::default());

        assert_eq!(recommendations[0].model.id, "smaller");
        assert!(recommendations[0]
            .badges
            .iter()
            .any(|badge| badge == "fastest"));
        assert_eq!(
            recommendations
                .iter()
                .find(|recommendation| recommendation.badges.iter().any(|badge| badge == "fastest"))
                .map(|recommendation| recommendation.model.id.as_str()),
            Some("smaller")
        );
        assert_eq!(
            recommendations
                .iter()
                .find(|recommendation| recommendation
                    .badges
                    .iter()
                    .any(|badge| badge == "best_fit"))
                .map(|recommendation| recommendation.model.id.as_str()),
            Some("largest")
        );
    }
}
