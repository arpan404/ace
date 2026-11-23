// SPDX-License-Identifier: Apache-2.0
//! Encoder threads the shell can't stop: counted as stuck once past their deadline, and only
//! until they really exit.
use super::*;
use crate::encode::worker::{Chosen, Decoded};
use crate::shell::watch::STALL_AFTER_MS;
use media_codec::fake::FakeEncoder;
use media_codec::{
    Codec, CodecError, CpuJpegCodec, EncodeSpec as Spec, EncodedUnit, Encoder, EncoderCaps,
    JpegCodec, Picture, Size,
};
use media_wire::capability::Backend;
use std::sync::{Condvar, Mutex};

/// Opens when the test lets the hung flushes return.
type Gate = Arc<(Mutex<bool>, Condvar)>;

/// An encoder whose flush never acks until the gate opens.
struct Hang {
    inner: FakeEncoder,
    gate: Gate,
}

impl Encoder for Hang {
    fn configure(&mut self, spec: &Spec) -> Result<(), CodecError> {
        self.inner.configure(spec)
    }
    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        self.inner.encode(picture, force_key)
    }
    fn poll(&mut self) -> Option<EncodedUnit> {
        self.inner.poll()
    }
    fn caps(&self) -> EncoderCaps {
        self.inner.caps()
    }
    fn flush(&mut self) -> Result<(), CodecError> {
        let (open, changed) = &*self.gate;
        let mut open = open
            .lock()
            .map_err(|_| CodecError::Backend("gate".into()))?;
        while !*open {
            open = changed
                .wait(open)
                .map_err(|_| CodecError::Backend("gate".into()))?;
        }
        Ok(())
    }
}

struct Hanging(Gate);

impl Backends for Hanging {
    fn encoder(&mut self, _: Codec) -> Result<Chosen, CodecError> {
        Ok(Chosen {
            encoder: Box::new(Hang {
                inner: FakeEncoder::new(Vec::new()),
                gate: self.0.clone(),
            }),
            backend: Backend::Vt,
            hardware: true,
            takes_jpeg: None,
        })
    }
    fn decode(&mut self, jpeg: &[u8], size: Size, _: Backend) -> Result<Decoded, CodecError> {
        let picture =
            JpegCodec::decode(&mut CpuJpegCodec::default(), jpeg, size.width, size.height)?;
        Ok(Decoded {
            picture,
            backend: Backend::Cpu,
            hardware: false,
            uploads: 0,
        })
    }
    fn probed(&self) -> Vec<media_wire::capability::Capability> {
        Vec::new()
    }
}

fn spec() -> Vec<media_wire::control::EncodeSpec> {
    vec![media_wire::control::EncodeSpec {
        id: 1,
        codec: "avc1.42E01F".into(),
        width: 64,
        height: 48,
        fps: 30,
        bitrate: 1_000_000,
        quantizer: None,
    }]
}

/// Opens one encoder, drains it (its flush hangs) and closes it at `closed_ms`.
fn hang_one(pictures: &mut Pictures, token: u64, closed_ms: u64) {
    let source = format!("s{token}");
    pictures.configure(&source, token, spec(), closed_ms);
    pictures.drain(&source, token);
    pictures.close(token, closed_ms);
}

#[test]
fn threads_hung_in_a_flush_count_as_stuck_after_their_deadline_until_they_exit() {
    let gate: Gate = Arc::default();
    let factory: BackendFactory = {
        let gate = gate.clone();
        Arc::new(move || Box::new(Hanging(gate.clone())) as Box<dyn Backends>)
    };
    let (outputs, _received) = mpsc::channel(64);
    let mut pictures = Pictures::with_backends(factory, outputs);

    hang_one(&mut pictures, 1, 1_000);
    assert_eq!(
        pictures.stuck(1_000 + STUCK_AFTER_MS - 1),
        0,
        "within its deadline"
    );
    assert_eq!(pictures.stuck(1_000 + STUCK_AFTER_MS), 1);
    hang_one(&mut pictures, 2, 1_500);
    assert_eq!(pictures.stuck(1_500 + STUCK_AFTER_MS), 2);

    // The flushes return: the threads exit and stop counting.
    let (open, changed) = &*gate;
    if let Ok(mut open) = open.lock() {
        *open = true;
    }
    changed.notify_all();
    let end = Instant::now() + Duration::from_secs(5);
    while pictures.stuck(1_000_000) > 0 {
        assert!(Instant::now() < end, "the threads never exited");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// What a [`Faulty`] backend does when the worker asks it for an encoder.
#[derive(Clone)]
enum Fault {
    Panic,
    /// Says it entered, then blocks until the gate opens (a codec call that never returns).
    Hang(Gate, std::sync::mpsc::Sender<()>),
}

struct Faulty(Fault);

impl Backends for Faulty {
    fn encoder(&mut self, _: Codec) -> Result<Chosen, CodecError> {
        match &self.0 {
            Fault::Panic => panic!("a codec bug"),
            Fault::Hang(gate, entered) => {
                let _ = entered.send(());
                let (open, changed) = &**gate;
                let mut open = open
                    .lock()
                    .map_err(|_| CodecError::Backend("gate".into()))?;
                while !*open {
                    open = changed
                        .wait(open)
                        .map_err(|_| CodecError::Backend("gate".into()))?;
                }
                Err(CodecError::Backend("released".into()))
            }
        }
    }
    fn decode(&mut self, jpeg: &[u8], size: Size, _: Backend) -> Result<Decoded, CodecError> {
        let picture =
            JpegCodec::decode(&mut CpuJpegCodec::default(), jpeg, size.width, size.height)?;
        Ok(Decoded {
            picture,
            backend: Backend::Cpu,
            hardware: false,
            uploads: 0,
        })
    }
    fn probed(&self) -> Vec<media_wire::capability::Capability> {
        Vec::new()
    }
}

fn faulty(fault: Fault) -> (Pictures, mpsc::Receiver<Encoded>) {
    let factory: BackendFactory =
        Arc::new(move || Box::new(Faulty(fault.clone())) as Box<dyn Backends>);
    let (outputs, received) = mpsc::channel(64);
    (Pictures::with_backends(factory, outputs), received)
}

fn jpeg() -> Vec<u8> {
    use media_codec::{CpuPicture, PixelFormat, Plane, StillCodec};
    let size = Size {
        width: 64,
        height: 48,
    };
    let plane = Plane {
        data: vec![90; 64 * 48 * 3],
        stride: 64 * 3,
    };
    let Ok(picture) = CpuPicture::new(size, PixelFormat::Rgb8, [plane], 0) else {
        panic!("picture");
    };
    match StillCodec::encode(&mut CpuJpegCodec::default(), &picture, 80) {
        Ok(jpeg) => jpeg,
        Err(error) => panic!("jpeg: {error}"),
    }
}

/// Opens source `s<token>` at `now_ms` and gives it a picture to encode.
fn open_one(pictures: &mut Pictures, token: u64, now_ms: u64) {
    pictures.configure(&format!("s{token}"), token, spec(), now_ms);
    pictures.picture(token, jpeg(), 1, 0);
}

fn release(gate: &Gate) {
    let (open, changed) = &**gate;
    if let Ok(mut open) = open.lock() {
        *open = true;
    }
    changed.notify_all();
}

#[test]
fn an_encoder_thread_that_panics_while_its_source_is_open_fails_that_source() {
    let (mut pictures, mut received) = faulty(Fault::Panic);
    open_one(&mut pictures, 7, 0);
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        match received.try_recv() {
            Ok((source, token, Output::Failed(reason))) => {
                assert_eq!((source.as_str(), token), ("s7", 7));
                assert_eq!(reason, "encoder-panicked");
                break;
            }
            Ok(_) => {}
            Err(_) => {
                assert!(Instant::now() < end, "the panic was never reported");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

#[test]
fn an_encoder_wedged_in_a_codec_call_is_failed_at_its_deadline_and_counts_as_stuck() {
    let gate: Gate = Arc::default();
    let (entered, inside) = std::sync::mpsc::channel();
    let (mut pictures, _received) = faulty(Fault::Hang(gate.clone(), entered));
    open_one(&mut pictures, 3, 0);
    assert!(
        inside.recv_timeout(Duration::from_secs(5)).is_ok(),
        "the codec call never started"
    );

    // Last seen turning at 1 000: silent since, inside one call.
    assert!(pictures.stalled(1_000).is_empty());
    assert!(
        pictures.stalled(1_000 + STALL_AFTER_MS - 1).is_empty(),
        "within its deadline"
    );
    assert_eq!(
        pictures.stalled(1_000 + STALL_AFTER_MS),
        vec![("s3".to_owned(), 3)]
    );
    assert!(
        pictures.stalled(1_000 + STALL_AFTER_MS + 1).is_empty(),
        "reported once"
    );
    // It can't be stopped, so it holds a slot until the call returns.
    assert_eq!(pictures.stuck(1_000 + STALL_AFTER_MS), 1);

    release(&gate);
    let end = Instant::now() + Duration::from_secs(5);
    while pictures.stuck(1_000_000) > 0 {
        assert!(Instant::now() < end, "the thread never exited");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn an_idle_encoder_thread_is_never_reported_stalled() {
    let (outputs, _received) = mpsc::channel(64);
    let factory: BackendFactory =
        Arc::new(|| Box::new(Hanging(Arc::default())) as Box<dyn Backends>);
    let mut pictures = Pictures::with_backends(factory, outputs);
    pictures.configure("s1", 1, spec(), 0);
    let mut now = 0;
    for _ in 0..4 {
        std::thread::sleep(Duration::from_millis(30));
        now += STALL_AFTER_MS;
        assert!(pictures.stalled(now).is_empty(), "idle at {now}");
    }
}
