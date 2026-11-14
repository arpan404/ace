// SPDX-License-Identifier: Apache-2.0
//! Through a real headless Chrome, found the way the daemon finds it. Each test is skipped,
//! saying so, on a machine with no Chrome.
#![cfg(unix)]

use media_chrome::{ChromeEncoder, ChromeOptions, ChromeSearch, find_chrome, jpeg_picture};
use media_codec::{
    Codec, CodecError, CpuJpegCodec, CpuPicture, EncodeSpec, EncodedUnit, Encoder, Picture,
    PixelFormat, Plane, RateControl, Size,
};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn chrome() -> Option<PathBuf> {
    let data_dir = std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".ace"));
    let found = find_chrome(&ChromeSearch::from_env(data_dir));
    match &found {
        Some(path) => eprintln!("media-chrome: using {}", path.display()),
        None => eprintln!(
            "media-chrome: SKIPPED, no Chrome found (set ACE_CHROMIUM_PATH or install ace's Chrome for Testing)"
        ),
    }
    found
}

fn encoder(name: &str) -> Option<(ChromeEncoder, PathBuf)> {
    let executable = chrome()?;
    let profiles =
        std::env::temp_dir().join(format!("media-chrome-real-{name}-{}", std::process::id()));
    Some((
        ChromeEncoder::new(ChromeOptions::new(executable, profiles.clone())),
        profiles,
    ))
}

const SIZE: Size = Size {
    width: 640,
    height: 360,
};

fn spec(size: Size) -> EncodeSpec {
    EncodeSpec {
        codec: Codec::H264,
        size,
        fps: 30,
        rate: RateControl::Bitrate(1_500_000),
    }
}

/// A moving gradient, so consecutive pictures differ.
fn rgba(size: Size, index: u64) -> Result<CpuPicture, CodecError> {
    let stride = size.width as usize * 4;
    let mut data = vec![0u8; stride * size.height as usize];
    for (y, row) in data.chunks_mut(stride).enumerate() {
        for (x, pixel) in row.chunks_exact_mut(4).enumerate() {
            let shift = index as usize * 7;
            pixel.copy_from_slice(&[
                ((x + shift) % 256) as u8,
                ((y + shift) % 256) as u8,
                ((x + y) % 256) as u8,
                255,
            ]);
        }
    }
    CpuPicture::new(
        size,
        PixelFormat::Rgba8,
        [Plane { data, stride }],
        index * 33_333,
    )
}

fn next_unit(encoder: &mut ChromeEncoder) -> Result<EncodedUnit, CodecError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(unit) = encoder.poll_result()? {
            return Ok(unit);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    Err(CodecError::DeadlineExceeded)
}

/// NAL unit types in a 4-byte-length-prefixed (AVCC) access unit; empty if malformed.
fn nal_types(data: &[u8]) -> Vec<u8> {
    let mut types = Vec::new();
    let mut at = 0;
    while at + 4 <= data.len() {
        let mut length = [0u8; 4];
        length.copy_from_slice(&data[at..at + 4]);
        let length = u32::from_be_bytes(length) as usize;
        at += 4;
        if length == 0 || at + length > data.len() {
            return Vec::new();
        }
        types.push(data[at] & 0x1F);
        at += length;
    }
    if at == data.len() { types } else { Vec::new() }
}

fn assert_h264(unit: &EncodedUnit) {
    let types = nal_types(&unit.data);
    assert!(!types.is_empty(), "AVCC access unit");
    if unit.key {
        assert!(
            types.contains(&5),
            "a keyframe holds an IDR slice: {types:?}"
        );
        let description = unit.description.as_deref().unwrap_or_default();
        // avcC: version 1, then the Constrained Baseline profile asked for.
        assert_eq!(description.first(), Some(&1));
        assert_eq!(description.get(1), Some(&0x42));
    } else {
        assert!(
            types.contains(&1),
            "a delta frame holds a non-IDR slice: {types:?}"
        );
        assert!(!types.contains(&5));
    }
}

#[test]
fn encodes_cpu_pictures_to_h264_with_keyframes_on_request() -> Result<(), CodecError> {
    let Some((mut encoder, profiles)) = encoder("cpu") else {
        return Ok(());
    };
    assert!(!encoder.caps().hardware);
    encoder.configure(&spec(SIZE))?;
    let mut keys = Vec::new();
    for index in 0..8u64 {
        encoder.encode(Picture::Cpu(rgba(SIZE, index)?), index == 5)?;
        let unit = next_unit(&mut encoder)?;
        assert_eq!((unit.size, unit.pts_us), (SIZE, index * 33_333));
        assert_h264(&unit);
        keys.push(unit.key);
    }
    assert_eq!(keys, [true, false, false, false, false, true, false, false]);
    encoder.flush()?;
    drop(encoder);
    let _ = std::fs::remove_dir_all(profiles);
    Ok(())
}

#[test]
fn encodes_jpeg_pictures_as_they_are() -> Result<(), CodecError> {
    let Some((mut encoder, profiles)) = encoder("jpeg") else {
        return Ok(());
    };
    encoder.configure(&spec(SIZE))?;
    let mut jpeg = CpuJpegCodec::default();
    for index in 0..4u64 {
        let rgba = rgba(SIZE, index)?;
        let bytes = jpeg.encode(&rgba, 80)?;
        encoder.encode(jpeg_picture(bytes, index * 33_333)?, false)?;
        let unit = next_unit(&mut encoder)?;
        assert_eq!(unit.pts_us, index * 33_333);
        assert_eq!(unit.key, index == 0);
        assert_h264(&unit);
    }
    drop(encoder);
    let _ = std::fs::remove_dir_all(profiles);
    Ok(())
}

#[test]
fn a_killed_chrome_is_restarted_and_encoding_resumes_at_a_keyframe() -> Result<(), CodecError> {
    let Some((mut encoder, profiles)) = encoder("crash") else {
        return Ok(());
    };
    encoder.configure(&spec(SIZE))?;
    for index in 0..3u64 {
        encoder.encode(Picture::Cpu(rgba(SIZE, index)?), false)?;
        next_unit(&mut encoder)?;
    }
    let pid = encoder.browser_pid().ok_or(CodecError::NotConfigured)?;
    let killed = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .map_err(|e| CodecError::Backend(e.to_string()))?;
    assert!(killed.success());
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut index = 3u64;
    let mut reported = 0;
    let resumed = loop {
        assert!(Instant::now() < deadline, "encoding did not resume");
        let _ = encoder.encode(Picture::Cpu(rgba(SIZE, index)?), false);
        index += 1;
        std::thread::sleep(Duration::from_millis(30));
        match encoder.poll_result() {
            Ok(Some(unit)) => break unit,
            Ok(None) => {}
            Err(CodecError::Backend(_)) => reported += 1,
            Err(other) => return Err(other),
        }
    };
    // The death is reported exactly once, whichever call noticed it first; a report queued
    // by a restart comes after the units already out.
    for _ in 0..3 {
        if let Err(CodecError::Backend(_)) = encoder.poll_result() {
            reported += 1;
        }
    }
    assert_eq!(reported, 1);
    assert!(resumed.key);
    assert_h264(&resumed);
    assert_eq!(encoder.restarts(), 1);
    assert_ne!(encoder.browser_pid(), Some(pid));
    drop(encoder);
    let _ = std::fs::remove_dir_all(profiles);
    Ok(())
}

#[test]
fn the_probe_trial_reports_a_working_software_encoder() {
    use media_wire::capability::{Backend, Step, TrialState};
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    let Some(executable) = chrome() else {
        return;
    };
    let profiles =
        std::env::temp_dir().join(format!("media-chrome-real-probe-{}", std::process::id()));
    let started = Instant::now();
    // A loaded machine's cold Chrome start can pass the 2 s production deadline; this test is
    // about the result, and prints the time it took.
    let capability = media_chrome::probe(
        ChromeOptions::new(executable, profiles.clone()),
        Duration::from_secs(15),
        Arc::new(AtomicBool::new(false)),
    );
    eprintln!("media-chrome: probe took {:?}", started.elapsed());
    assert_eq!(capability.state, TrialState::Ok);
    assert_eq!(
        (capability.step, capability.backend),
        (Step::Encode, Backend::Chrome)
    );
    assert!(!capability.hardware && !capability.zero_copy);
    assert!(capability.max_width > 0);
    let _ = std::fs::remove_dir_all(profiles);
}

/// Processes in a process group, from `pgrep -g`.
fn group_members(group: u32) -> usize {
    std::process::Command::new("pgrep")
        .args(["-g", &group.to_string()])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).lines().count())
        .unwrap_or(0)
}

#[test]
fn dropping_the_encoder_ends_every_chrome_process() -> Result<(), CodecError> {
    let Some((mut encoder, profiles)) = encoder("tree") else {
        return Ok(());
    };
    encoder.configure(&spec(SIZE))?;
    encoder.encode(Picture::Cpu(rgba(SIZE, 0)?), false)?;
    next_unit(&mut encoder)?;
    let group = encoder.browser_pid().ok_or(CodecError::NotConfigured)?;
    assert!(group_members(group) > 1, "Chrome runs helpers in its group");
    drop(encoder);
    assert_eq!(group_members(group), 0);
    assert_eq!(
        std::fs::read_dir(&profiles).map(|e| e.count()).unwrap_or(0),
        0
    );
    let _ = std::fs::remove_dir_all(profiles);
    Ok(())
}

/// The owner half of the parent-death test.
#[test]
fn chrome_owner_entry() -> Result<(), CodecError> {
    let Some(dir) = std::env::var_os("MEDIA_CHROME_REAL_OWNER").map(PathBuf::from) else {
        return Ok(());
    };
    let Some((mut encoder, _)) = encoder("owner") else {
        return Ok(());
    };
    encoder.configure(&spec(SIZE))?;
    let pid = encoder.browser_pid().ok_or(CodecError::NotConfigured)?;
    std::fs::write(dir.join("browser.pid"), pid.to_string())
        .map_err(|e| CodecError::Backend(e.to_string()))?;
    std::thread::sleep(Duration::from_secs(60));
    Ok(())
}

#[test]
fn chrome_exits_with_every_helper_when_its_owner_is_killed() -> Result<(), CodecError> {
    if chrome().is_none() {
        return Ok(());
    }
    let io = |e: std::io::Error| CodecError::Backend(e.to_string());
    let dir = std::env::temp_dir().join(format!("media-chrome-real-owner-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(io)?;
    let mut owner = std::process::Command::new(std::env::current_exe().map_err(io)?)
        .args([
            "--exact",
            "chrome_owner_entry",
            "--test-threads=1",
            "--quiet",
        ])
        .env("MEDIA_CHROME_REAL_OWNER", &dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(io)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let group = loop {
        if let Some(pid) = std::fs::read_to_string(dir.join("browser.pid"))
            .ok()
            .and_then(|t| t.parse::<u32>().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline, "the owner never started Chrome");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(group_members(group) > 0);
    owner.kill().map_err(io)?;
    owner.wait().map_err(io)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while group_members(group) > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(group_members(group), 0, "Chrome outlived its owner");
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}
