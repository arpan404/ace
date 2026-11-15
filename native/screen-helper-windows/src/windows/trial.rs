//! The capture → encode trial at helper start (ADR 0148): one BGRA texture, like a capture
//! frame, through the same device, video processor and MFT live video uses, bounded to 2 s.
//! What the hello reports comes from what this observed, never from the GPU's name.
use crate::media::capability::{Trial, TrialState};
use media_codec::{Codec, CpuPicture, EncodeSpec, Encoder, PixelFormat, Plane, RateControl, Size};
use media_mf::{upload, MfDevice, MfEncoder};
use std::{sync::mpsc, time::Duration};

pub const DEADLINE: Duration = Duration::from_secs(2);

pub fn run() -> Trial {
    let (tx, rx) = mpsc::channel();
    // A trial that hangs (a stuck driver) is abandoned; its thread exits with the process.
    std::thread::spawn(move || {
        let _ = tx.send(attempt());
    });
    match rx.recv_timeout(DEADLINE) {
        Ok(trial) => trial,
        Err(_) => Trial {
            state: TrialState::TimedOut,
            ..Trial::failed("no H.264 output within 2 s")
        },
    }
}

fn attempt() -> Trial {
    let device = match MfDevice::new() {
        Ok(device) => device,
        Err(error) => return Trial::failed(format!("D3D11 device: {error}")),
    };
    let video_processor = device.has_video();
    let gpu = !device.adapter().software;
    let failed = |detail: String| Trial {
        video_processor,
        gpu,
        ..Trial::failed(detail)
    };
    if !video_processor {
        return failed("the D3D11 device has no video processor".into());
    }
    let size = Size {
        width: 640,
        height: 360,
    };
    let bgra = CpuPicture::new(
        size,
        PixelFormat::Bgra8,
        [Plane {
            data: vec![0x40; 640 * 360 * 4],
            stride: 640 * 4,
        }],
        0,
    );
    let surface = match bgra.and_then(|picture| upload(&device, &picture)) {
        Ok(surface) => surface,
        Err(error) => return failed(format!("trial texture: {error}")),
    };
    let mut encoder = match MfEncoder::new(Some(device)) {
        Ok(encoder) => encoder,
        Err(error) => return failed(format!("Media Foundation: {error}")),
    };
    let spec = EncodeSpec {
        codec: Codec::H264,
        size,
        fps: 60,
        rate: RateControl::Bitrate(2_000_000),
    };
    if let Err(error) = encoder.configure(&spec) {
        return failed(format!("no H.264 encoder MFT: {error}"));
    }
    if let Err(error) = encoder.encode(surface.into_picture(0), true) {
        return failed(format!("trial frame: {error}"));
    }
    let readbacks = encoder.last_copies().readbacks;
    let _ = encoder.flush();
    let mut codec = None;
    while let Ok(Some(unit)) = encoder.poll_result() {
        if unit.key {
            codec = unit
                .description
                .as_deref()
                .and_then(|record| media_mf::nal::codec_string(Codec::H264, record));
        }
    }
    if codec.is_none() {
        return failed("the MFT produced no keyframe".into());
    }
    Trial {
        state: TrialState::Ok,
        hardware: encoder.hardware(),
        video_processor,
        gpu,
        readbacks,
        codec,
        detail: encoder.name().unwrap_or_default().to_string(),
    }
}
