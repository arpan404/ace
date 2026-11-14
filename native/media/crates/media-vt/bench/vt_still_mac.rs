// SPDX-License-Identifier: Apache-2.0
use crate::common::*;
use media_codec::*;
use media_vt::{DecodeOutput, VtDecoder, VtEncoder, VtFormat, VtJpeg};
use std::time::Instant;

type Fallible<T> = Result<T, Box<dyn std::error::Error>>;

pub fn main() -> Fallible<()> {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .iter()
        .position(|a| a == "--path")
        .and_then(|i| args.get(i + 1))
        .map_or("gpu", String::as_str);
    if path != "gpu" {
        return Err(
            "media-vt runs the GPU path; the CPU path is media-codec's `still --path cpu`".into(),
        );
    }
    let source = Size {
        width: 1206,
        height: 2622,
    };
    let target = fit_size(
        source,
        Size {
            width: 1568,
            height: 1568,
        },
    )?;
    let frames = Frames::new(source, 4)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&EncodeSpec {
        codec: Codec::Hevc,
        size: source,
        fps: 60,
        rate: RateControl::Bitrate(12_000_000),
    })?;
    encoder.encode(frames.picture(0, 0)?, true)?;
    encoder.flush()?;
    let current = encoder.poll_result()?.ok_or("no keyframe")?;
    drop(encoder);

    let mut decoder = VtDecoder::new(DecodeOutput {
        size: Some(target),
        format: VtFormat::Nv12,
    });
    let mut jpeg = VtJpeg::new(VtFormat::Nv12);
    let mut out = Vec::new();
    let load = load_average();
    let (mut totals, mut decodes, mut encodes) = (Vec::new(), Vec::new(), Vec::new());
    for _run in 0..3 {
        for sample in 0..220 {
            let started = Instant::now();
            let picture = decoder.decode(&current)?.ok_or("nothing decoded")?;
            let decoded = Instant::now();
            jpeg.encode_into(&picture, 80, &mut out)?;
            let done = Instant::now();
            if sample >= 20 {
                totals.push((done - started).as_secs_f64() * 1e3);
                decodes.push((decoded - started).as_secs_f64() * 1e3);
                encodes.push((done - decoded).as_secs_f64() * 1e3);
            }
        }
    }
    if jpeg_size(&out)? != target {
        return Err("still has the wrong size".into());
    }
    let path = jpeg.last_path();
    let p95 = percentile(&mut totals, 0.95);
    let median = percentile(&mut totals, 0.5);
    let enforced = enforce(load);
    let pass = p95 <= 8.0;
    println!(
        "{{\"bench\":\"still\",\"path\":\"gpu\",\"backend\":\"vt\",\"machine\":\"{}\",\"os\":\"{}\",\"load\":{load:.1},\"cores\":{},\"enforced\":{enforced},\"source\":\"1206x2622 hevc\",\"target\":\"{}x{}\",\"samples\":{},\"medianMs\":{median:.3},\"p95Ms\":{p95:.3},\"decodeP95Ms\":{:.3},\"jpegP95Ms\":{:.3},\"decodeHardware\":{},\"jpegEncodeHardware\":{},\"readbacks\":{},\"uploads\":{},\"bytes\":{},\"maximumP95Ms\":8,\"pass\":{pass}}}",
        machine(),
        os_build(),
        cores(),
        target.width,
        target.height,
        totals.len(),
        percentile(&mut decodes, 0.95),
        percentile(&mut encodes, 0.95),
        decoder.hardware(),
        path.hardware,
        path.copies.readbacks,
        path.copies.uploads,
        out.len(),
    );
    if enforced && !pass {
        return Err("below acceptance".into());
    }
    Ok(())
}
