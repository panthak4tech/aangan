use aangan_types::HardwareProfile;
use fitcalc::{
    builtin_catalog, estimate, kv_cache_bytes, recommend, Fit, ModelSpec, Placement, Tunables,
};

fn load(json: &str) -> HardwareProfile {
    serde_json::from_str(json).expect("fixture parses")
}

fn rtx3060() -> HardwareProfile {
    load(include_str!("../../../fixtures/profiles/rtx3060_12gb.json"))
}

fn cpu8() -> HardwareProfile {
    load(include_str!("../../../fixtures/profiles/cpu_only_8gb.json"))
}

fn model(id_part: &str) -> ModelSpec {
    builtin_catalog()
        .into_iter()
        .find(|model| model.id.contains(id_part))
        .expect("model in catalog")
}

#[test]
fn kv_cache_matches_hand_calculation() {
    assert_eq!(kv_cache_bytes(&model("qwen2.5-7b"), 8192), 469_762_048);
}

#[test]
fn seven_b_runs_great_fully_on_rtx3060() {
    let estimate = estimate(&rtx3060(), &model("qwen2.5-7b"), 4096, &Tunables::default());
    assert_eq!(estimate.placement, Placement::FullGpu);
    assert!(
        estimate.fit == Fit::Great,
        "got {:?} at {:.1} tok/s",
        estimate.fit,
        estimate.decode_tps
    );
}

#[test]
fn fourteen_b_does_not_fit_on_8gb_cpu_only() {
    let estimate = estimate(&cpu8(), &model("qwen2.5-14b"), 4096, &Tunables::default());
    assert_eq!(estimate.fit, Fit::WontFit);
}

#[test]
fn small_model_is_usable_on_8gb_cpu_only() {
    let estimate = estimate(&cpu8(), &model("qwen2.5-1.5b"), 4096, &Tunables::default());
    assert!(
        estimate.fit >= Fit::Good,
        "got {:?} at {:.1} tok/s",
        estimate.fit,
        estimate.decode_tps
    );
}

#[test]
fn comfortable_models_are_ranked_first() {
    let recommendations = recommend(&rtx3060(), &builtin_catalog(), 4096, &Tunables::default());
    let first_bad = recommendations
        .iter()
        .position(|item| item.estimate.fit < Fit::Good)
        .unwrap_or(recommendations.len());
    assert!(recommendations[..first_bad]
        .iter()
        .all(|item| item.estimate.fit >= Fit::Good));
    assert!(recommendations[first_bad..]
        .iter()
        .all(|item| item.estimate.fit < Fit::Good));
    assert!(recommendations[0].estimate.fit >= Fit::Good);
}
