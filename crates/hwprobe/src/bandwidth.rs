use rayon::prelude::*;
use std::time::Instant;

/// Multi-threaded sequential read over a buffer much larger than any CPU cache.
/// Returns the best of several passes in decimal GB/s.
pub fn measure_read_gbps() -> Option<f64> {
    const BYTES: usize = 256 * 1024 * 1024;
    let n = BYTES / std::mem::size_of::<u64>();
    let data: Vec<u64> = (0..n as u64).collect();

    let mut best = 0.0_f64;
    for _ in 0..4 {
        let start = Instant::now();
        let sum: u64 = data
            .par_chunks(1 << 16)
            .map(|chunk| {
                chunk
                    .iter()
                    .fold(0u64, |acc, &value| acc.wrapping_add(value))
            })
            .reduce(|| 0, u64::wrapping_add);
        let seconds = start.elapsed().as_secs_f64();
        std::hint::black_box(sum);
        if seconds > 0.0 {
            best = best.max(BYTES as f64 / seconds / 1e9);
        }
    }
    if best > 0.0 {
        Some(best)
    } else {
        None
    }
}
