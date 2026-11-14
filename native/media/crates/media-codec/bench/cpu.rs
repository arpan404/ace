// SPDX-License-Identifier: Apache-2.0
use crate::allocation;
use media_codec::*;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};
struct ObservedCodec {
    codec: CpuJpegCodec,
    counts: Arc<[AtomicUsize; 3]>,
}
impl StillCodec for ObservedCodec {
    fn decode(&mut self, jpeg: &[u8]) -> Result<CpuPicture, CodecError> {
        self.codec.decode(jpeg)
    }
    fn encode(&mut self, p: &CpuPicture, q: u8) -> Result<Vec<u8>, CodecError> {
        self.codec.encode(p, q)
    }
    fn transcode_observed(
        &mut self,
        jpeg: &[u8],
        target: Size,
        q: u8,
        output: &mut Vec<u8>,
        observer: &mut dyn FnMut(StillStage),
    ) -> Result<(), CodecError> {
        let mut previous = allocation::calls();
        StillCodec::transcode_observed(&mut self.codec, jpeg, target, q, output, &mut |stage| {
            let current = allocation::calls();
            let index = match stage {
                StillStage::Decoded => 0,
                StillStage::Scaled => 1,
                StillStage::Encoded => 2,
            };
            self.counts[index].fetch_add(current.saturating_sub(previous), Ordering::Relaxed);
            previous = current;
            observer(stage);
        })
    }
}
pub fn run(input: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let target = fit_size(
        jpeg_size(input)?,
        Size {
            width: 1568,
            height: 1568,
        },
    )?;
    let kernel = CpuJpegCodec::default().simd_kernel();
    if !libjpeg_turbo_rs::simd_and_std_features_enabled() {
        return Err("JPEG SIMD is disabled".into());
    }
    if kernel == SimdKernel::Scalar && cfg!(any(target_arch = "aarch64", target_arch = "x86_64")) {
        #[cfg(target_arch = "x86_64")]
        if std::arch::is_x86_feature_detected!("avx2") {
            return Err("scalar resampling on a CPU with AVX2".into());
        }
    }
    println!(
        "CPU resample: {kernel:?}, SIMD DCT enabled; target {}x{} q80",
        target.width, target.height
    );
    let epoch = Instant::now();
    let now: WorkerClock = Arc::new(move || epoch.elapsed().as_micros() as u64);
    let counts = Arc::new([
        AtomicUsize::new(0),
        AtomicUsize::new(0),
        AtomicUsize::new(0),
    ]);
    let counts_factory = Arc::clone(&counts);
    let mut workers = StillWorkers::with_factory(
        WorkerLimits {
            physical_cores: num_cpus::get_physical(),
            input_bytes: input.len(),
            output_bytes: jpeg_capacity(target),
        },
        now,
        Arc::new(move || {
            Box::new(ObservedCodec {
                codec: CpuJpegCodec::default(),
                counts: Arc::clone(&counts_factory),
            })
        }),
    )?;
    let count = workers.worker_count();
    let warmup = count * 5;
    let mut samples = [0.0; 50];
    let mut stages = [[0.0; 50]; 3];
    let mut allocations = 0;
    for i in 0..warmup + 50 {
        let start = Instant::now();
        if i >= warmup {
            allocation::start();
        }
        let mut buffer = workers.try_input().ok_or(CodecError::Backpressure)?;
        buffer.set(input)?;
        workers
            .try_submit(i as u64, buffer, target, 80, u64::MAX)
            .map_err(|r| r.error)?;
        let result = workers.recv()?;
        let output = result.data?;
        std::hint::black_box(output.as_slice());
        drop(output);
        if i >= warmup {
            allocations += allocation::stop();
            samples[i - warmup] = start.elapsed().as_secs_f64() * 1000.0;
            let timing = result
                .stages_us
                .ok_or("worker did not report stage timing")?;
            for (stage, value) in stages.iter_mut().zip(timing) {
                stage[i - warmup] = value as f64 / 1000.0;
            }
        }
    }
    samples.sort_by(f64::total_cmp);
    for stage in &mut stages {
        stage.sort_by(f64::total_cmp);
    }
    println!(
        "workers={count}: median {:.3} ms, p95 {:.3} ms; p50/p95 decode {:.3}/{:.3}, scale {:.3}/{:.3}, encode {:.3}/{:.3} ms",
        samples[25],
        samples[47],
        stages[0][25],
        stages[0][47],
        stages[1][25],
        stages[1][47],
        stages[2][25],
        stages[2][47]
    );
    println!(
        "Rust allocations: {allocations}/50 frames ({:.1}/frame); includes worker queues and codec internals",
        allocations as f64 / 50.0
    );
    println!(
        "allocations/frame by stage: decode {:.1}, scale {:.1}, encode {:.1}",
        counts[0].load(Ordering::Relaxed) as f64 / 50.0,
        counts[1].load(Ordering::Relaxed) as f64 / 50.0,
        counts[2].load(Ordering::Relaxed) as f64 / 50.0
    );
    let limit = if cfg!(target_os = "macos") {
        20.0
    } else {
        30.0
    };
    println!(
        "latency gate <= {limit} ms p95: {}; allocation gate = 0: {}",
        if samples[47] <= limit { "PASS" } else { "FAIL" },
        if allocations == 0 { "PASS" } else { "FAIL" }
    );
    if allocations != 0 || samples[47] > limit {
        return Err("CPU still acceptance gates failed".into());
    }
    Ok(())
}
