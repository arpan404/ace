// SPDX-License-Identifier: Apache-2.0
//! A source opened before the probe's late hardware result moves onto it (ADR 0148: hardware
//! whenever it is available), and stops being degraded.
use super::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Hardware appears once `found` is set, as a late `capabilities.changed` makes it appear.
struct Late {
    found: Arc<AtomicBool>,
    opened: Vec<Backend>,
    /// The JPEG decoder is built once, with the hardware the probe had found then.
    decoder: Option<bool>,
}

impl Backends for Late {
    fn encoder(&mut self, _codec: Codec) -> Result<Chosen, CodecError> {
        let hardware = self.found.load(Ordering::SeqCst);
        let backend = if hardware {
            Backend::Vt
        } else {
            Backend::Chrome
        };
        self.opened.push(backend);
        Ok(Chosen {
            encoder: Box::new(FakeEncoder::new(Vec::new())),
            backend,
            hardware,
            takes_jpeg: None,
        })
    }
    fn decode(&mut self, jpeg: &[u8], size: Size, _: Backend) -> Result<Decoded, CodecError> {
        let hardware = *self
            .decoder
            .get_or_insert_with(|| self.found.load(Ordering::SeqCst));
        let picture =
            JpegCodec::decode(&mut CpuJpegCodec::default(), jpeg, size.width, size.height)?;
        Ok(Decoded {
            picture,
            backend: if hardware { Backend::Vt } else { Backend::Cpu },
            hardware,
            uploads: 0,
        })
    }
    fn probed(&self) -> Vec<media_wire::capability::Capability> {
        Vec::new()
    }
    fn choice(&self, _codec: Codec) -> Option<(Backend, bool)> {
        let hardware = self.found.load(Ordering::SeqCst);
        Some(if hardware {
            (Backend::Vt, true)
        } else {
            (Backend::Chrome, false)
        })
    }
    fn refresh(&mut self) {
        if self.found.load(Ordering::SeqCst) && self.decoder == Some(false) {
            self.decoder = None;
        }
    }
}

fn reports(out: &[Output]) -> Vec<&Acceleration> {
    out.iter()
        .filter_map(|o| match o {
            Output::Report(a) => Some(a),
            _ => None,
        })
        .collect()
}

#[test]
fn a_source_opened_before_the_late_hardware_result_moves_onto_it_at_a_keyframe() {
    let found = Arc::new(AtomicBool::new(false));
    let mut worker = Worker::new(Late {
        found: found.clone(),
        opened: Vec::new(),
        decoder: None,
    });
    let mut out = Vec::new();
    worker.command(Command::Configure(vec![spec(1, 1_000_000)]), 0, &mut out);
    worker.command(picture(1), 1_000, &mut out);
    worker.command(picture(1), 2_000, &mut out);
    let before = reports(&out);
    assert!(
        before.last().is_some_and(|a| a.degraded),
        "on the fallback first"
    );

    // A change that improves nothing leaves the source alone.
    worker.command(Command::Capabilities, 2_500, &mut out);
    assert_eq!(worker.backends.opened, [Backend::Chrome]);

    // The probe's late result: VideoToolbox encodes and decodes JPEG in hardware.
    found.store(true, Ordering::SeqCst);
    let mut after = Vec::new();
    worker.command(Command::Capabilities, 3_000, &mut after);
    worker.command(picture(1), 4_000, &mut after);
    worker.command(picture(1), 5_000, &mut after);
    assert_eq!(worker.backends.opened, [Backend::Chrome, Backend::Vt]);
    let keys: Vec<u32> = units(&after).iter().map(|u| u.flags & 1).collect();
    assert_eq!(
        keys.first(),
        Some(&1),
        "the hardware encoder starts at a keyframe: {keys:?}"
    );
    let Some(report) = reports(&after).last().copied() else {
        panic!("no new report");
    };
    assert!(!report.degraded && report.reason.is_none(), "{report:?}");
    let step = |s: Step| {
        report
            .steps
            .iter()
            .find(|x| x.step == s)
            .map(|x| (x.backend, x.hardware))
    };
    assert_eq!(step(Step::Encode), Some((Backend::Vt, true)));
    assert_eq!(step(Step::JpegDecode), Some((Backend::Vt, true)));
}
