// SPDX-License-Identifier: Apache-2.0
//! Encode throughput of the encoder MFT this machine picks, from CPU NV12 (the software
//! MFT's path) and, with a video processor, from a BGRA texture through the GPU scaler.
//! `cargo run --release -p media-mf --example mf_encode -- [frames]`
#[cfg(windows)]
fn main() -> Result<(), media_codec::CodecError> {
    use media_codec::*;
    use media_mf::*;
    use std::time::Instant;
    let frames: u32 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(300);
    let size = Size {
        width: 1920,
        height: 1080,
    };
    let (w, h) = (size.width as usize, size.height as usize);
    let pictures: Vec<CpuPicture> = (0..8)
        .map(|phase| {
            let luma = (0..w * h)
                .map(|i| ((i % w + i / w + phase * 9) % 220 + 16) as u8)
                .collect();
            let chroma = vec![128u8; w * h / 2];
            CpuPicture::new(
                size,
                PixelFormat::Nv12,
                [
                    Plane {
                        data: luma,
                        stride: w,
                    },
                    Plane {
                        data: chroma,
                        stride: w,
                    },
                ],
                0,
            )
        })
        .collect::<Result<_, _>>()?;
    let device = MfDevice::new().ok();
    let mut encoder = MfEncoder::new(device.clone());
    encoder.configure(&EncodeSpec {
        codec: Codec::H264,
        size,
        fps: 30,
        rate: RateControl::Bitrate(8_000_000),
    })?;
    let started = Instant::now();
    let (mut units, mut bytes, mut copies) = (0u32, 0usize, Copies::default());
    for i in 0..frames {
        let mut picture = pictures[i as usize % pictures.len()].clone();
        picture.pts_us = u64::from(i) * 33_333;
        loop {
            match encoder.encode(Picture::Cpu(picture.clone()), i == 0) {
                Err(CodecError::Backpressure) => {
                    std::thread::sleep(std::time::Duration::from_millis(1))
                }
                other => break other?,
            }
            while let Some(unit) = encoder.poll_result()? {
                units += 1;
                bytes += unit.data.len();
            }
        }
        let c = encoder.last_copies();
        copies.readbacks += c.readbacks;
        copies.uploads += c.uploads;
        while let Some(unit) = encoder.poll_result()? {
            units += 1;
            bytes += unit.data.len();
        }
    }
    encoder.flush()?;
    while let Some(unit) = encoder.poll_result()? {
        units += 1;
        bytes += unit.data.len();
    }
    let seconds = started.elapsed().as_secs_f64();
    println!(
        "{{\"encoder\":{:?},\"hardware\":{},\"adapter\":{:?},\"frames\":{frames},\"units\":{units},\"fps\":{:.1},\"kbitPerSecondAt30\":{:.0},\"readbacksPerFrame\":{:.2},\"uploadsPerFrame\":{:.2}}}",
        encoder.name().unwrap_or(""),
        encoder.hardware(),
        device.as_ref().map(|d| d.adapter().description.clone()),
        f64::from(frames) / seconds,
        bytes as f64 * 8.0 * 30.0 / f64::from(units.max(1)) / 1000.0,
        f64::from(copies.readbacks) / f64::from(frames),
        f64::from(copies.uploads) / f64::from(frames),
    );
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    println!("mf_encode runs on Windows only");
}
