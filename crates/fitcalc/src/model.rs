use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct License {
    pub id: String,
    /// true = OSI-approved open-source license; false = "open weight" with custom terms.
    pub osi_open: bool,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSpec {
    pub id: String,
    pub name: String,
    pub family: String,
    pub params_b: f64,
    /// For mixture-of-experts models: parameters active per token. Dense: equal to params_b.
    pub active_params_b: f64,
    pub quant: String,
    pub file_size_bytes: u64,
    pub n_layers: u32,
    pub n_kv_heads: u32,
    pub head_dim: u32,
    pub context_max: u32,
    pub license: License,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub verified: bool,
}
