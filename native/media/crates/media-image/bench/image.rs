// SPDX-License-Identifier: Apache-2.0
//! cargo run --release -p media-image --example image
//! One-shot image jobs (ADR 0201) on the jobs the daemon sends, against the Bun image-pipeline path
//! they replace (about 10 ms on the Mac for the screenshot fit, docs/media/plan.md M5). Five
//! warm-ups, then 50 samples each; one JSON line per job. Fails above its bound unless
//! ACE_MEDIA_BENCH_REPORT_ONLY=1, or when the load average is past twice the core count.
use media_image::{Input, run};
use media_wire::image::{ImageOp, ImageOutput, Layer, LayerFit};
use std::time::Instant;

const SCREEN: &[u8] = include_bytes!("../../media-codec/bench/data/still-1206x2622.jpg");
/// A phone body as a Simulator's chrome draws one: 430 × 932 points, glass, a screen opening
/// and buttons.
const CHROME: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="430" height="932" viewBox="0 0 430 932"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#3a3a3c"/><stop offset="1" stop-color="#1c1c1e"/></linearGradient><mask id="m"><rect width="430" height="932" rx="68" fill="#fff"/><rect x="18" y="18" width="394" height="896" rx="52" fill="#000"/></mask></defs><rect width="430" height="932" rx="68" fill="url(#g)" mask="url(#m)"/><rect x="6" y="6" width="418" height="920" rx="62" fill="none" stroke="#000" stroke-width="10"/><rect x="160" y="30" width="110" height="32" rx="16" fill="#000"/><rect x="-3" y="200" width="6" height="60" rx="3" fill="#2c2c2e"/><rect x="427" y="250" width="6" height="100" rx="3" fill="#2c2c2e"/></svg>"##;

fn fit(width: u32, height: u32, output: ImageOutput, vector_scale: Option<f64>) -> ImageOp {
    ImageOp::Fit {
        max_pixels: 64 * 1024 * 1024,
        width,
        height,
        auto_orient: true,
        vector_scale,
        output,
    }
}

/// Median and p95 in ms of 50 runs after five warm-ups.
fn measure(inputs: &[Input], op: &ImageOp) -> Result<(f64, f64, usize), String> {
    let mut samples = Vec::with_capacity(50);
    let mut bytes = 0;
    for i in 0..55 {
        let start = Instant::now();
        let done = run(inputs, op, &|| false).map_err(|f| f.message)?;
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        bytes = done.bytes.len();
        if i >= 5 {
            samples.push(ms);
        }
    }
    samples.sort_by(f64::total_cmp);
    Ok((samples[25], samples[47], bytes))
}

fn load_too_high() -> bool {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
    std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse::<f64>().ok())
        .is_some_and(|load| load > 2.0 * cores)
}

/// The screenshot fit's bound: the Bun image pipeline's ≈ 10 ms on the Mac, and M5's x86 AVX2 bound.
const FIT_BOUND_MS: f64 = if cfg!(target_os = "macos") {
    10.0
} else {
    15.0
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let report_only =
        std::env::var("ACE_MEDIA_BENCH_REPORT_ONLY").as_deref() == Ok("1") || load_too_high();
    let screen = [Input::Encoded(SCREEN)];
    let chrome = [Input::Encoded(CHROME.as_bytes())];
    let tiles: Vec<Input> = (0..8).map(|_| Input::Encoded(SCREEN)).collect();
    let mut layers = Vec::new();
    for index in 0..8i32 {
        let (left, top) = ((index % 4) * 400, (index / 4) * 278);
        layers.push(Layer::Image {
            input: index as u32,
            left,
            top,
            width: 400,
            height: 250,
            fit: LayerFit::Contain,
            mask: None,
        });
        layers.push(Layer::Text {
            text: format!("+{} MS", index * 100),
            left: left + 8,
            top: top + 257,
            size: 16,
            color: [255, 255, 255, 255],
        });
    }
    let jobs: Vec<(&str, &[Input], ImageOp, f64)> = vec![
        // The screenshot and model-image fit: JPEG to JPEG, M5's planar path (Bun: ≈ 10 ms).
        (
            "fit-jpeg-1568",
            &screen,
            fit(
                1568,
                1568,
                ImageOutput::Jpeg {
                    quality: 80,
                    background: None,
                },
                None,
            ),
            FIT_BOUND_MS,
        ),
        // An attachment preview: decode, scale with alpha, PNG.
        (
            "preview-png-512",
            &screen,
            fit(512, 512, ImageOutput::Png, None),
            40.0,
        ),
        // Device chrome drawn as PNG at up to three pixels a point (1116 × 2400), once per device type.
        (
            "svg-png-2400",
            &chrome,
            fit(2400, 2400, ImageOutput::Png, Some(3.0)),
            150.0,
        ),
        // The measurement filmstrip, once per measurement: eight full screens and their captions.
        (
            "filmstrip-1600",
            &tiles,
            ImageOp::Compose {
                width: 1600,
                height: 556,
                background: [24, 24, 24, 255],
                max_pixels: 16 * 1024 * 1024,
                layers,
                output: ImageOutput::Jpeg {
                    quality: 65,
                    background: Some([24, 24, 24]),
                },
            },
            400.0,
        ),
    ];
    let mut failed = Vec::new();
    for (name, inputs, op, bound) in &jobs {
        let (median, p95, bytes) = measure(inputs, op)?;
        println!(
            "{{\"bench\":\"image\",\"job\":\"{name}\",\"medianMs\":{median:.3},\"p95Ms\":{p95:.3},\"bytes\":{bytes},\"boundP95Ms\":{bound}}}"
        );
        if p95 > *bound {
            failed.push(*name);
        }
    }
    if !failed.is_empty() && !report_only {
        return Err(format!("over bound: {}", failed.join(", ")).into());
    }
    Ok(())
}
