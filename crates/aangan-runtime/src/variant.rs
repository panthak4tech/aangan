use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Cpu,
    Vulkan,
    Cuda,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Variant {
    pub variant: String,
    pub kind: Kind,
    #[serde(default)]
    pub requires_cuda_driver: Option<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct HwFacts {
    pub nvidia_cuda_driver: Option<u32>,
    pub has_discrete_gpu: bool,
}

pub fn pick_variant<'a>(offered: &'a [Variant], hw: &HwFacts) -> Option<&'a Variant> {
    let cuda = offered
        .iter()
        .filter(|v| v.kind == Kind::Cuda)
        .filter(|v| match (hw.nvidia_cuda_driver, v.requires_cuda_driver) {
            (Some(have), Some(need)) => have >= need,
            _ => false,
        })
        .max_by_key(|v| v.requires_cuda_driver);
    if cuda.is_some() {
        return cuda;
    }
    if hw.has_discrete_gpu {
        if let Some(v) = offered.iter().find(|v| v.kind == Kind::Vulkan) {
            return Some(v);
        }
    }
    offered.iter().find(|v| v.kind == Kind::Cpu)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offered() -> Vec<Variant> {
        vec![
            Variant {
                variant: "cpu".into(),
                kind: Kind::Cpu,
                requires_cuda_driver: None,
            },
            Variant {
                variant: "vulkan".into(),
                kind: Kind::Vulkan,
                requires_cuda_driver: None,
            },
            Variant {
                variant: "cuda-12.4".into(),
                kind: Kind::Cuda,
                requires_cuda_driver: Some(12040),
            },
            Variant {
                variant: "cuda-13.1".into(),
                kind: Kind::Cuda,
                requires_cuda_driver: Some(13010),
            },
        ]
    }

    fn name(v: Option<&Variant>) -> &str {
        v.map(|v| v.variant.as_str()).unwrap_or("none")
    }

    #[test]
    fn newest_supported_cuda_wins() {
        let o = offered();
        let hw = HwFacts {
            nvidia_cuda_driver: Some(13020),
            has_discrete_gpu: true,
        };
        assert_eq!(name(pick_variant(&o, &hw)), "cuda-13.1");
        let hw = HwFacts {
            nvidia_cuda_driver: Some(12060),
            has_discrete_gpu: true,
        };
        assert_eq!(name(pick_variant(&o, &hw)), "cuda-12.4");
    }

    #[test]
    fn old_driver_falls_back_to_vulkan_then_cpu() {
        let o = offered();
        let hw = HwFacts {
            nvidia_cuda_driver: Some(11080),
            has_discrete_gpu: true,
        };
        assert_eq!(name(pick_variant(&o, &hw)), "vulkan");
        let hw = HwFacts {
            nvidia_cuda_driver: None,
            has_discrete_gpu: false,
        };
        assert_eq!(name(pick_variant(&o, &hw)), "cpu");
    }
}
