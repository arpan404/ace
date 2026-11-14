// SPDX-License-Identifier: Apache-2.0
//! The `Encoder` contract and the supervision rules, against a fake browser that speaks the
//! real pipe and page protocol (`support/fake_browser.rs`). No Chrome needed.
#![cfg(unix)]

mod support {
    pub mod fake_browser;
}

use media_chrome::{ChromeEncoder, ChromeOptions, MAX_IN_FLIGHT};
use media_codec::{
    Codec, CodecError, CpuPicture, EncodeSpec, EncodedUnit, Encoder, Picture, PixelFormat, Plane,
    RateControl, Size,
};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use support::fake_browser;

/// The fake browser's entry point; a no-op when the test runs normally.
#[test]
fn fake_browser_entry() {
    if std::env::var_os(fake_browser::ENTRY).is_some() {
        fake_browser::run();
    }
}

const SIZE: Size = Size {
    width: 64,
    height: 32,
};

fn spec(size: Size) -> EncodeSpec {
    EncodeSpec {
        codec: Codec::H264,
        size,
        fps: 30,
        rate: RateControl::Bitrate(1_000_000),
    }
}

fn picture(size: Size, pts_us: u64) -> Result<Picture, CodecError> {
    let stride = size.width as usize * 4;
    Ok(Picture::Cpu(CpuPicture::new(
        size,
        PixelFormat::Rgba8,
        [Plane {
            data: vec![80; stride * size.height as usize],
            stride,
        }],
        pts_us,
    )?))
}

struct Fixture {
    dir: PathBuf,
}
impl Fixture {
    fn new(name: &str, settings: &[(&str, &str)]) -> Result<(Self, ChromeOptions), CodecError> {
        let dir = std::env::temp_dir().join(format!("media-chrome-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut owned: Vec<(String, String)> = settings
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        // File settings name files inside the fixture's directory.
        for (key, value) in &mut owned {
            if key == "FAKE_ONCE" || key == "FAKE_LOG" {
                *value = dir.join(value.as_str()).display().to_string();
            }
        }
        let borrowed: Vec<(&str, &str)> = owned
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let script = fake_browser::install(&dir, "fake_browser_entry", &borrowed)
            .map_err(|e| CodecError::Backend(e.to_string()))?;
        let mut options = ChromeOptions::new(script, dir.join("profiles"));
        options.startup_timeout = Duration::from_secs(10);
        options.reply_timeout = Duration::from_secs(3);
        options.restart_backoff = Duration::from_millis(20);
        Ok((Self { dir }, options))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn next_unit(encoder: &mut ChromeEncoder) -> Result<EncodedUnit, CodecError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Some(unit) = encoder.poll_result()? {
            return Ok(unit);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    Err(CodecError::DeadlineExceeded)
}

fn sequence_of(unit: &EncodedUnit) -> u32 {
    let mut word = [0u8; 4];
    word.copy_from_slice(&unit.data[..4]);
    u32::from_be_bytes(word)
}

fn process_running(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[test]
fn units_keep_order_and_timing_with_a_keyframe_first_and_on_request() -> Result<(), CodecError> {
    let (_fixture, options) = Fixture::new("order", &[])?;
    let mut encoder = ChromeEncoder::new(options);
    assert_eq!(
        encoder.encode(picture(SIZE, 0)?, false),
        Err(CodecError::NotConfigured)
    );
    assert!(!encoder.caps().hardware);
    encoder.configure(&spec(SIZE))?;
    let mut keys = Vec::new();
    for (index, force) in [false, false, true, false].into_iter().enumerate() {
        encoder.encode(picture(SIZE, index as u64 * 33_333)?, force)?;
        let unit = next_unit(&mut encoder)?;
        assert_eq!(unit.pts_us, index as u64 * 33_333);
        assert_eq!(sequence_of(&unit), index as u32 + 1);
        assert_eq!((unit.size, unit.duration_us), (SIZE, 33_333));
        assert_eq!(unit.description.is_some(), unit.key);
        keys.push(unit.key);
    }
    assert_eq!(keys, [true, false, true, false]);
    encoder.flush()?;
    assert!(encoder.poll_result()?.is_none());
    Ok(())
}

#[test]
fn a_picture_of_another_size_is_refused_and_a_new_size_starts_at_a_keyframe()
-> Result<(), CodecError> {
    let (_fixture, options) = Fixture::new("resize", &[])?;
    let mut encoder = ChromeEncoder::new(options);
    encoder.configure(&spec(SIZE))?;
    encoder.encode(picture(SIZE, 0)?, false)?;
    next_unit(&mut encoder)?;
    let bigger = Size {
        width: 128,
        height: 64,
    };
    assert!(matches!(
        encoder.encode(picture(bigger, 1)?, false),
        Err(CodecError::InvalidInput(_))
    ));
    encoder.configure(&spec(bigger))?;
    encoder.encode(picture(bigger, 2)?, false)?;
    let unit = next_unit(&mut encoder)?;
    assert_eq!((unit.size, unit.key), (bigger, true));
    Ok(())
}

#[test]
fn a_refused_configuration_leaves_the_previous_one_running() -> Result<(), CodecError> {
    let (_fixture, options) = Fixture::new("refuse", &[("FAKE_REFUSE_WIDTH", "1000")])?;
    let mut encoder = ChromeEncoder::new(options);
    encoder.configure(&spec(SIZE))?;
    let refused = Size {
        width: 1000,
        height: 500,
    };
    assert!(matches!(
        encoder.configure(&spec(refused)),
        Err(CodecError::Unsupported(_))
    ));
    encoder.encode(picture(SIZE, 7)?, false)?;
    let unit = next_unit(&mut encoder)?;
    assert_eq!((unit.size, unit.pts_us), (SIZE, 7));
    Ok(())
}

#[test]
fn pictures_beyond_the_in_flight_window_are_refused_as_backpressure() -> Result<(), CodecError> {
    let (_fixture, options) = Fixture::new("stall", &[("FAKE_STALL", "1")])?;
    let mut encoder = ChromeEncoder::new(options);
    encoder.configure(&spec(SIZE))?;
    for pts in 0..MAX_IN_FLIGHT as u64 {
        encoder.encode(picture(SIZE, pts)?, false)?;
    }
    assert_eq!(
        encoder.encode(picture(SIZE, 99)?, false),
        Err(CodecError::Backpressure)
    );
    Ok(())
}

#[test]
fn a_crashed_browser_is_replaced_and_the_stream_resumes_at_a_keyframe() -> Result<(), CodecError> {
    let (_fixture, options) = Fixture::new(
        "crash",
        &[("FAKE_EXIT_AFTER", "3"), ("FAKE_ONCE", "crashed")],
    )?;
    let mut encoder = ChromeEncoder::new(options);
    encoder.configure(&spec(SIZE))?;
    let first_pid = encoder.browser_pid();
    for pts in 0..2 {
        encoder.encode(picture(SIZE, pts)?, false)?;
        next_unit(&mut encoder)?;
    }
    // The third picture kills the browser; it never comes out.
    encoder.encode(picture(SIZE, 2)?, false)?;
    // The death is reported once by poll_result, not hidden.
    let deadline = Instant::now() + Duration::from_secs(5);
    let reported = loop {
        match encoder.poll_result() {
            Err(CodecError::Backend(reason)) => break reason,
            Ok(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            other => return Err(CodecError::Backend(format!("no death reported: {other:?}"))),
        }
    };
    assert!(reported.contains("next picture"), "{reported}");
    assert_eq!(encoder.poll_result(), Ok(None));
    let mut resumed = None;
    let mut pts = 3;
    while resumed.is_none() && Instant::now() < deadline {
        encoder.encode(picture(SIZE, pts)?, false)?;
        pts += 1;
        std::thread::sleep(Duration::from_millis(20));
        resumed = encoder.poll_result()?;
    }
    let unit = resumed.ok_or(CodecError::DeadlineExceeded)?;
    assert!(unit.key, "the first unit after a restart is a keyframe");
    assert!(unit.pts_us >= 3);
    assert_eq!(encoder.restarts(), 1);
    assert_ne!(encoder.browser_pid(), first_pid);
    Ok(())
}

#[test]
fn a_browser_that_keeps_dying_is_given_up_on() -> Result<(), CodecError> {
    let (_fixture, options) = Fixture::new("dying", &[("FAKE_EXIT_AFTER", "1")])?;
    let mut encoder = ChromeEncoder::new(options);
    encoder.configure(&spec(SIZE))?;
    let mut last = Ok(());
    for pts in 0..40 {
        last = encoder.encode(picture(SIZE, pts)?, false);
        if matches!(&last, Err(CodecError::Backend(reason)) if reason.contains("keeps exiting")) {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    assert!(
        matches!(&last, Err(CodecError::Backend(reason)) if reason.contains("keeps exiting")),
        "{last:?}"
    );
    // Given up for good: every call says so.
    assert_eq!(encoder.poll_result(), last.clone().map(|()| None));
    assert_eq!(encoder.configure(&spec(SIZE)), last);
    Ok(())
}

#[test]
fn a_page_that_never_opens_fails_start_within_the_timeout() -> Result<(), CodecError> {
    let (_fixture, mut options) = Fixture::new("no-page", &[("FAKE_NO_PAGE", "1")])?;
    options.startup_timeout = Duration::from_millis(500);
    let mut encoder = ChromeEncoder::new(options);
    let started = Instant::now();
    assert_eq!(
        encoder.configure(&spec(SIZE)),
        Err(CodecError::DeadlineExceeded)
    );
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(encoder.browser_pid().is_none());
    Ok(())
}

#[test]
fn dropping_the_encoder_closes_the_browser_and_removes_its_profile() -> Result<(), CodecError> {
    let (fixture, options) = Fixture::new("drop", &[])?;
    let mut encoder = ChromeEncoder::new(options);
    encoder.configure(&spec(SIZE))?;
    let pid = encoder.browser_pid().ok_or(CodecError::NotConfigured)?;
    assert!(process_running(pid));
    drop(encoder);
    assert!(!process_running(pid));
    let profiles = std::fs::read_dir(fixture.dir.join("profiles"))
        .map(|entries| entries.count())
        .unwrap_or(0);
    assert_eq!(profiles, 0);
    Ok(())
}

#[test]
fn failed_launches_count_toward_the_restart_budget_and_back_off() -> Result<(), CodecError> {
    let (fixture, options) = Fixture::new(
        "launch",
        &[("FAKE_DIE_AT_START", "1"), ("FAKE_LOG", "starts")],
    )?;
    let max = options.max_restarts;
    let mut encoder = ChromeEncoder::new(options);
    let mut outcomes = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let outcome = encoder.configure(&spec(SIZE));
        let gave_up = matches!(&outcome, Err(CodecError::Backend(reason)) if reason.contains("keeps failing"));
        outcomes.push(outcome);
        if gave_up || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(
        outcomes.contains(&Err(CodecError::Backpressure)),
        "a relaunch waits for its backoff"
    );
    let starts = std::fs::read_to_string(fixture.dir.join("starts")).unwrap_or_default();
    assert_eq!(starts.lines().count(), max as usize + 1);
    // No more launches once given up.
    for _ in 0..5 {
        assert!(encoder.configure(&spec(SIZE)).is_err());
    }
    let starts = std::fs::read_to_string(fixture.dir.join("starts")).unwrap_or_default();
    assert_eq!(starts.lines().count(), max as usize + 1);
    Ok(())
}

fn ended_by_flood(flood: &str, expected: &str) -> Result<(), CodecError> {
    let (_fixture, options) = Fixture::new(&format!("flood-{expected}"), &[("FAKE_FLOOD", flood)])?;
    let mut encoder = ChromeEncoder::new(options);
    encoder.configure(&spec(SIZE))?;
    encoder.encode(picture(SIZE, 0)?, false)?;
    // Nobody takes the chunks while the page floods.
    std::thread::sleep(Duration::from_secs(1));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match encoder.poll_result() {
            Ok(Some(_)) => {}
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                return Err(CodecError::Backend(
                    "the flood never ended the session".into(),
                ));
            }
            Err(CodecError::Backend(reason)) => {
                assert!(reason.contains(expected), "{reason}");
                return Ok(());
            }
            Err(other) => return Err(other),
        }
    }
}

#[test]
fn a_page_that_floods_bytes_nobody_takes_is_ended() -> Result<(), CodecError> {
    ended_by_flood("80:1048576", "bytes")
}

#[test]
fn a_page_that_floods_events_nobody_takes_is_ended() -> Result<(), CodecError> {
    ended_by_flood("400:16", "events")
}

/// The other half of the parent-death test: a process that owns an encoder, then is killed.
#[test]
fn owner_entry() -> Result<(), CodecError> {
    let Some(dir) = std::env::var_os("MEDIA_CHROME_OWNER").map(PathBuf::from) else {
        return Ok(());
    };
    let mut encoder = ChromeEncoder::new(ChromeOptions::new(
        dir.join("fake-chrome"),
        dir.join("profiles"),
    ));
    encoder.configure(&spec(SIZE))?;
    let pid = encoder.browser_pid().ok_or(CodecError::NotConfigured)?;
    std::fs::write(dir.join("browser.pid"), pid.to_string())
        .map_err(|e| CodecError::Backend(e.to_string()))?;
    std::thread::sleep(Duration::from_secs(60));
    Ok(())
}

#[test]
fn the_browser_exits_when_its_owner_is_killed() -> Result<(), CodecError> {
    let (fixture, _) = Fixture::new("owner", &[])?;
    let io = |e: std::io::Error| CodecError::Backend(e.to_string());
    let mut owner = std::process::Command::new(std::env::current_exe().map_err(io)?)
        .args(["--exact", "owner_entry", "--test-threads=1", "--quiet"])
        .env("MEDIA_CHROME_OWNER", &fixture.dir)
        .stdout(std::process::Stdio::null())
        .spawn()
        .map_err(io)?;
    let pid_file = fixture.dir.join("browser.pid");
    let deadline = Instant::now() + Duration::from_secs(10);
    let browser = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|t| t.parse::<u32>().ok())
        {
            break pid;
        }
        assert!(
            Instant::now() < deadline,
            "the owner never started its browser"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(process_running(browser));
    owner.kill().map_err(io)?;
    owner.wait().map_err(io)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_running(browser) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!process_running(browser), "the browser outlived its owner");
    Ok(())
}
