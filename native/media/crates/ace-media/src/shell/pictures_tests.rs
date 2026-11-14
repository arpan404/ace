// SPDX-License-Identifier: Apache-2.0
//! Encoder threads the shell can't stop: counted as stuck once past their deadline, and only
//! until they really exit.
use super::*;
use crate::encode::worker::{Chosen, Decoded};
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
    fn jpeg_hardware_expected(&self) -> bool {
        false
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
