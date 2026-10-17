use crate::model::ModelSpec;
use serde::Deserialize;

#[derive(Deserialize)]
struct CatalogFile {
    #[allow(dead_code)]
    schema_version: u32,
    models: Vec<ModelSpec>,
}

pub fn parse_catalog(json: &str) -> Result<Vec<ModelSpec>, serde_json::Error> {
    Ok(serde_json::from_str::<CatalogFile>(json)?.models)
}

/// The catalog compiled into the binary (path is relative to this file).
pub fn builtin_catalog() -> Vec<ModelSpec> {
    parse_catalog(include_str!("../../../catalog/models.json"))
        .expect("catalog/models.json must be valid")
}
