//! A window shared inside a larger buffer (GNOME's window streams, `SPA_META_VideoCrop`) must
//! never send what lies outside its region, on any encoder path. The buffer outside the region
//! is pure red, the region green: whatever the encoder makes is decoded (ffmpeg) and must hold
//! no red at all, at the region's size.
//!
//! Runs the encoders this machine has, chosen as the helper chooses them: with no GPU that is
//! the last resort on shared memory; with `ACE_SCREEN_VAAPI=1` or `ACE_MEDIA_NV=1` on real
//! hardware, theirs. Needs ffmpeg and (for the last resort) a Chrome or Chromium, and runs only
//! with `ACE_E2_ENCODERS=1`, since it starts real encoders.
#![cfg(target_os = "linux")]
use ace_screen_helper_linux::media::{
    encoder::{Captured, Input, ScreenEncoder},
    pixels::SPA_BGRX,
    stream::StreamSettings,
};
use media_wire::capability::Backend;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const WIDTH: u32 = 640;
const HEIGHT: u32 = 480;
const REGION: (u32, u32, u32, u32) = (96, 64, 320, 240);

/// BGRx: red everywhere, green inside the region.
fn pattern() -> Vec<u8> {
    let mut bytes = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let at = ((y * WIDTH + x) * 4) as usize;
            let inside = x >= REGION.0
                && x < REGION.0 + REGION.2
                && y >= REGION.1
                && y < REGION.1 + REGION.3;
            bytes[at..at + 4].copy_from_slice(if inside {
                &[0, 255, 0, 255]
            } else {
                &[0, 0, 255, 255]
            });
        }
    }
    bytes
}

fn decode(stream: &[u8]) -> (Vec<u8>, String) {
    let mut ffmpeg = Command::new("ffmpeg")
        .args([
            "-v", "error", "-f", "h264", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("ffmpeg");
    let mut stdin = ffmpeg.stdin.take().expect("stdin");
    let input = stream.to_vec();
    let feeder = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = ffmpeg.wait_with_output().expect("ffmpeg ran");
    let _ = feeder.join();
    (
        out.stdout,
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn encode_on(backend: Backend, chrome: Option<media_chrome::ChromeOptions>) {
    let mut encoder = ScreenEncoder::open(backend, chrome).expect("encoder opens");
    let settings = StreamSettings {
        codec: "h264".into(),
        max_width: 3840,
        max_height: 3840,
        fps: 30,
        bitrate: 2_000_000,
    };
    let bytes = pattern();
    let mut stream = Vec::new();
    let mut units = 0;
    for n in 0..6u64 {
        let picture = Captured {
            input: Input::Shared {
                bytes: &bytes,
                stride: (WIDTH * 4) as usize,
            },
            format: SPA_BGRX,
            width: WIDTH,
            height: HEIGHT,
            region: REGION,
            pts_us: 1 + n * 33_333,
        };
        encoder
            .encode(&picture, &settings, n == 0)
            .expect("encodes");
        std::thread::sleep(Duration::from_millis(40));
        while let Some(unit) = encoder.poll().expect("polls") {
            stream.extend_from_slice(&unit.data);
            units += 1;
        }
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while units < 6 && Instant::now() < deadline {
        while let Some(unit) = encoder.poll().expect("polls") {
            stream.extend_from_slice(&unit.data);
            units += 1;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    encoder.close();
    assert!(units > 0, "{backend:?} made no units");
    let (rgb, errors) = decode(&stream);
    let pixels = (REGION.2 * REGION.3 * 3) as usize;
    assert!(
        !rgb.is_empty() && rgb.len() % pixels == 0,
        "{backend:?}: decoded {} bytes, not frames of the region's size; {errors}",
        rgb.len()
    );
    let red = rgb
        .chunks(3)
        .filter(|p| p[0] > 150 && p[1] < 100 && p[2] < 100)
        .count();
    assert_eq!(
        red, 0,
        "{backend:?} sent pixels from outside the shared region"
    );
}

#[test]
fn a_cropped_buffer_never_sends_pixels_outside_its_region_on_any_encoder_this_machine_has() {
    if std::env::var_os("ACE_E2_ENCODERS").is_none_or(|v| v != "1") {
        eprintln!("skipped: set ACE_E2_ENCODERS=1 to run the real encoders");
        return;
    }
    let mut ran = Vec::new();
    if std::env::var_os("ACE_SCREEN_VAAPI").is_some_and(|v| v == "1") {
        encode_on(Backend::Vaapi, None);
        ran.push("vaapi");
    }
    if std::env::var_os("ACE_MEDIA_NV").is_some_and(|v| v == "1") {
        encode_on(Backend::Nv, None);
        ran.push("nv");
    }
    let search = media_chrome::ChromeSearch::from_env(None);
    if let Some(executable) = media_chrome::find_chrome(&search) {
        let profiles = std::env::temp_dir().join(format!("ace-crop-{}", std::process::id()));
        encode_on(
            Backend::Chrome,
            Some(media_chrome::ChromeOptions::new(executable, profiles)),
        );
        ran.push("chrome");
    }
    assert!(!ran.is_empty(), "no encoder to run here");
    eprintln!("ran: {ran:?}");
}
