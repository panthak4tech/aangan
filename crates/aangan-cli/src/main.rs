use std::path::PathBuf;

use aangan_types::HardwareProfile;
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use fitcalc::{builtin_catalog, recommend, Fit, Placement, Recommendation, Tunables};
use hwprobe::{probe, ProbeOptions};

#[derive(Parser)]
#[command(
    name = "aangan",
    version,
    about = "Find out which open AI models your PC can run"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Detect this PC's hardware
    Scan {
        /// Print JSON (use this when filing a hardware report)
        #[arg(long)]
        json: bool,
        /// Skip the memory speed measurement
        #[arg(long)]
        no_bench: bool,
    },
    /// Rank models for this PC or for a saved profile
    Recommend {
        /// Context length in tokens
        #[arg(long, default_value_t = 4096)]
        context: u32,
        /// Use a saved profile (from `aangan scan --json`) instead of scanning
        #[arg(long)]
        profile: Option<PathBuf>,
        #[arg(long)]
        no_bench: bool,
        #[arg(long)]
        json: bool,
        /// Include models that will not fit
        #[arg(long)]
        all: bool,
    },
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Scan { json, no_bench } => {
            let profile = probe(&ProbeOptions {
                measure_bandwidth: !no_bench,
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&profile)?);
            } else {
                print_profile(&profile);
            }
        }
        Command::Recommend {
            context,
            profile,
            no_bench,
            json,
            all,
        } => {
            let profile: HardwareProfile = match profile {
                Some(path) => {
                    let text = std::fs::read_to_string(&path)
                        .with_context(|| format!("reading {}", path.display()))?;
                    serde_json::from_str(&text).context("parsing profile JSON")?
                }
                None => probe(&ProbeOptions {
                    measure_bandwidth: !no_bench,
                }),
            };
            let recommendations = recommendations_for(&profile, context, all);
            if json {
                println!("{}", serde_json::to_string_pretty(&recommendations)?);
            } else {
                print_profile(&profile);
                print_recommendations(&recommendations, context);
            }
        }
    }
    Ok(())
}

fn recommendations_for(
    profile: &HardwareProfile,
    context: u32,
    include_wont_fit: bool,
) -> Vec<Recommendation> {
    let mut recommendations = recommend(profile, &builtin_catalog(), context, &Tunables::default());
    if !include_wont_fit {
        recommendations.retain(|item| item.estimate.fit != Fit::WontFit);
    }
    recommendations
}

fn gb(bytes: u64) -> f64 {
    bytes as f64 / 1e9
}

fn print_profile(profile: &HardwareProfile) {
    println!("Hardware");
    println!(
        "  OS   : {} {} ({})",
        profile.os.name, profile.os.version, profile.os.arch
    );
    println!(
        "  CPU  : {} - {}C/{}T - {}",
        profile.cpu.brand,
        profile.cpu.physical_cores,
        profile.cpu.logical_cores,
        profile.cpu.features.join(" ")
    );
    let bandwidth = match profile.memory.read_bandwidth_gbps {
        Some(value) => format!("{value:.0} GB/s read ({})", profile.memory.bandwidth_source),
        None => format!("speed {}", profile.memory.bandwidth_source),
    };
    println!(
        "  RAM  : {:.1} GB total - {}",
        gb(profile.memory.total_bytes),
        bandwidth
    );
    if profile.gpus.is_empty() {
        println!("  GPU  : none detected");
    }
    for gpu in &profile.gpus {
        let kind = if gpu.is_integrated {
            "integrated"
        } else {
            "discrete"
        };
        let bandwidth = gpu
            .bandwidth_gbps
            .map(|value| format!(" - ~{value:.0} GB/s ({})", gpu.bandwidth_source))
            .unwrap_or_default();
        println!(
            "  GPU  : {} - {} - {:.1} GB VRAM{}",
            gpu.name,
            kind,
            gb(gpu.dedicated_vram_bytes),
            bandwidth
        );
    }
}

fn fit_label(fit: Fit) -> &'static str {
    match fit {
        Fit::Great => "Great",
        Fit::Good => "Good",
        Fit::Slow => "Slow",
        Fit::TooSlow => "Too slow",
        Fit::WontFit => "Won't fit",
    }
}

fn print_recommendations(recommendations: &[Recommendation], context: u32) {
    println!("\nModels for a {context}-token context (speeds are ESTIMATES)\n");
    println!(
        "{:<3} {:<26} {:<8} {:<10} {:>8} {:>9}  Runs on",
        "#", "Model", "Quant", "Fit", "~tok/s", "Memory"
    );
    for recommendation in recommendations {
        let estimate = &recommendation.estimate;
        let placement = match &estimate.placement {
            Placement::FullGpu => "GPU".to_string(),
            Placement::PartialGpu {
                gpu_layers,
                total_layers,
            } => format!("GPU {gpu_layers}/{total_layers} layers + CPU"),
            Placement::CpuOnly => "CPU".to_string(),
            Placement::NoFit => "-".to_string(),
        };
        println!(
            "{:<3} {:<26} {:<8} {:<10} {:>8.1} {:>7.1}GB  {}  {}",
            recommendation.rank,
            recommendation.model.name,
            recommendation.model.quant,
            fit_label(estimate.fit),
            estimate.decode_tps,
            gb(estimate.memory_required_bytes),
            placement,
            recommendation.badges.join(",")
        );
    }
    println!(
        "\nEstimates use formulas documented in docs/estimation.md. Measured benchmarks arrive in a later release."
    );
}

#[cfg(test)]
mod tests {
    use super::{recommendations_for, Cli, Fit};
    use aangan_types::HardwareProfile;
    use clap::Parser;

    #[test]
    fn parses_scan_json_and_no_bench_flags() {
        assert!(Cli::try_parse_from(["aangan", "scan", "--json", "--no-bench"]).is_ok());
    }

    #[test]
    fn parses_recommendation_profile_and_filter_flags() {
        assert!(Cli::try_parse_from([
            "aangan",
            "recommend",
            "--context",
            "8192",
            "--profile",
            "profile.json",
            "--no-bench",
            "--json",
            "--all",
        ])
        .is_ok());
    }

    #[test]
    fn all_flag_includes_non_fitting_models_with_memory_reasons() {
        let profile: HardwareProfile =
            serde_json::from_str(include_str!("../../../fixtures/profiles/cpu_only_8gb.json"))
                .expect("profile fixture parses");
        let visible = recommendations_for(&profile, 4096, false);
        let all = recommendations_for(&profile, 4096, true);

        assert!(visible.iter().all(|item| item.estimate.fit != Fit::WontFit));
        let non_fitting = all
            .iter()
            .find(|item| item.estimate.fit == Fit::WontFit)
            .expect("--all should include a model that does not fit");
        assert!(non_fitting
            .estimate
            .reasons
            .iter()
            .any(|reason| reason.contains("Needs about") && reason.contains("GB")));
    }
}
