// SPDX-License-Identifier: Apache-2.0
//! The availability trial, and the rule that keeps this encoder a last resort.

use crate::{ChromeEncoder, ChromeOptions, MAX_SIDE, h264_codec_string};
use media_codec::{
    Codec, CodecError, CpuPicture, EncodeSpec, Encoder, Picture, PixelFormat, Plane, RateControl,
    Size,
};
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::time::{Duration, Instant};

/// The trial encodes one picture of this size.
pub const TRIAL_SIZE: Size = Size {
    width: 1280,
    height: 720,
};

/// The Chrome encoder is a candidate only when no backend's probe found a working hardware
/// encoder. Pass every other backend's encode entries.
pub fn last_resort_needed(probed: &[Capability]) -> bool {
    !probed.iter().any(|capability| {
        capability.step == Step::Encode
            && capability.hardware
            && capability.state == TrialState::Ok
            && capability.backend != Backend::Chrome
    })
}

fn entry(state: TrialState) -> Capability {
    let ok = state == TrialState::Ok;
    Capability {
        step: Step::Encode,
        codec: Some(h264_codec_string(TRIAL_SIZE, 30)),
        backend: Backend::Chrome,
        hardware: false,
        zero_copy: false,
        state,
        max_width: if ok { MAX_SIDE } else { 0 },
        max_height: if ok { MAX_SIDE } else { 0 },
    }
}

/// One bounded trial: start Chrome, configure, encode one picture and wait for its chunk, on a
/// thread of its own. Past `deadline` the trial is `timed-out` and returns at once; its thread
/// stops at its next step and closes the browser. `cancel` ends it the same way.
pub fn probe(options: ChromeOptions, deadline: Duration, cancel: Arc<AtomicBool>) -> Capability {
    let (sender, result) = channel();
    let stop = cancel.clone();
    let started = std::thread::Builder::new()
        .name("media-chrome-probe".into())
        .spawn(move || {
            let outcome = trial(options, deadline, &stop);
            let _ = sender.send(outcome);
        });
    if started.is_err() {
        return entry(TrialState::Failed);
    }
    let until = Instant::now() + deadline;
    loop {
        let left = until.saturating_duration_since(Instant::now());
        let wait = left.min(Duration::from_millis(50));
        match result.recv_timeout(wait) {
            Ok(Ok(())) => return entry(TrialState::Ok),
            Ok(Err(CodecError::DeadlineExceeded)) => return entry(TrialState::TimedOut),
            Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => {
                return entry(TrialState::Failed);
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if cancel.load(Ordering::SeqCst) || left.is_zero() {
            cancel.store(true, Ordering::SeqCst);
            return entry(TrialState::TimedOut);
        }
    }
}

fn trial(
    mut options: ChromeOptions,
    deadline: Duration,
    cancel: &AtomicBool,
) -> Result<(), CodecError> {
    let until = Instant::now() + deadline;
    options.startup_timeout = options.startup_timeout.min(deadline);
    options.reply_timeout = options.reply_timeout.min(deadline);
    options.max_restarts = 0;
    let check = || {
        if cancel.load(Ordering::SeqCst) || Instant::now() >= until {
            Err(CodecError::DeadlineExceeded)
        } else {
            Ok(())
        }
    };
    let mut encoder = ChromeEncoder::new(options);
    encoder.configure(&EncodeSpec {
        codec: Codec::H264,
        size: TRIAL_SIZE,
        fps: 30,
        rate: RateControl::Bitrate(2_000_000),
    })?;
    check()?;
    let stride = TRIAL_SIZE.width as usize * 4;
    let picture = CpuPicture::new(
        TRIAL_SIZE,
        PixelFormat::Rgba8,
        [Plane {
            data: vec![96; stride * TRIAL_SIZE.height as usize],
            stride,
        }],
        0,
    )?;
    encoder.encode(Picture::Cpu(picture), true)?;
    loop {
        check()?;
        if let Some(unit) = encoder.poll_result()? {
            return if unit.key && !unit.data.is_empty() {
                Ok(())
            } else {
                Err(CodecError::Backend(
                    "the trial's first chunk was not a keyframe".into(),
                ))
            };
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(backend: Backend, hardware: bool, state: TrialState) -> Capability {
        Capability {
            backend,
            hardware,
            state,
            ..entry(TrialState::Ok)
        }
    }

    #[test]
    fn chrome_is_a_candidate_only_without_a_working_hardware_encoder() {
        assert!(last_resort_needed(&[]));
        // The software MFT and a failed or timed-out hardware trial leave no hardware encoder.
        assert!(last_resort_needed(&[
            found(Backend::Mf, false, TrialState::Ok),
            found(Backend::Vaapi, true, TrialState::Failed),
            found(Backend::Nv, true, TrialState::TimedOut),
        ]));
        assert!(!last_resort_needed(&[found(
            Backend::Vt,
            true,
            TrialState::Ok
        )]));
        // A hardware decoder is not an encoder.
        assert!(last_resort_needed(&[Capability {
            step: Step::Decode,
            ..found(Backend::Vt, true, TrialState::Ok)
        }]));
    }

    #[test]
    fn a_browser_that_cannot_start_fails_its_trial_within_the_deadline() {
        let options = ChromeOptions::new(
            "/nonexistent/chrome".into(),
            std::env::temp_dir().join("media-chrome-probe-missing"),
        );
        let started = Instant::now();
        let result = probe(
            options,
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(result.state, TrialState::Failed);
        assert_eq!((result.max_width, result.max_height), (0, 0));
        assert!(!result.hardware);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn a_trial_that_hangs_times_out_at_its_deadline() -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        // A "browser" that never answers on its pipe.
        let dir = std::env::temp_dir().join(format!("media-chrome-hang-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let script = dir.join("chrome");
        std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n")?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
        let started = Instant::now();
        let result = probe(
            ChromeOptions::new(script, dir.clone()),
            Duration::from_millis(300),
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(result.state, TrialState::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(600));
        // The abandoned trial closes its browser and profile on its own thread.
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
