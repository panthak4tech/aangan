use crate::estimate::{estimate, Estimate, Fit, Tunables};
use crate::model::ModelSpec;
use aangan_types::HardwareProfile;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recommendation {
    pub model: ModelSpec,
    pub estimate: Estimate,
    pub rank: u32,
    /// "best_fit", "fastest"
    pub badges: Vec<String>,
}

/// Models that run at least "Good" come first, largest first; the rest follow, best fit first.
pub fn recommend(
    profile: &HardwareProfile,
    catalog: &[ModelSpec],
    context: u32,
    tunables: &Tunables,
) -> Vec<Recommendation> {
    let mut items: Vec<(ModelSpec, Estimate)> = catalog
        .iter()
        .map(|model| (model.clone(), estimate(profile, model, context, tunables)))
        .collect();

    let compare_speed = |a: f64, b: f64| a.partial_cmp(&b).unwrap_or(Ordering::Equal);

    items.sort_by(|(model_a, estimate_a), (model_b, estimate_b)| {
        let a_good = estimate_a.fit >= Fit::Good;
        let b_good = estimate_b.fit >= Fit::Good;
        b_good.cmp(&a_good).then_with(|| {
            if a_good && b_good {
                compare_speed(model_b.params_b, model_a.params_b)
                    .then_with(|| compare_speed(estimate_b.decode_tps, estimate_a.decode_tps))
            } else {
                estimate_b
                    .fit
                    .cmp(&estimate_a.fit)
                    .then_with(|| compare_speed(estimate_b.decode_tps, estimate_a.decode_tps))
            }
        })
    });

    let fastest_id = items
        .iter()
        .filter(|(_, estimate)| estimate.fit != Fit::WontFit)
        .max_by(|(_, estimate_a), (_, estimate_b)| {
            compare_speed(estimate_a.decode_tps, estimate_b.decode_tps)
        })
        .map(|(model, _)| model.id.clone());
    let best_id = items
        .iter()
        .find(|(_, estimate)| estimate.fit >= Fit::Good)
        .map(|(model, _)| model.id.clone());

    items
        .into_iter()
        .enumerate()
        .map(|(index, (model, estimate))| {
            let mut badges = Vec::new();
            if best_id.as_deref() == Some(model.id.as_str()) {
                badges.push("best_fit".to_string());
            }
            if fastest_id.as_deref() == Some(model.id.as_str()) {
                badges.push("fastest".to_string());
            }
            Recommendation {
                model,
                estimate,
                rank: index as u32 + 1,
                badges,
            }
        })
        .collect()
}
