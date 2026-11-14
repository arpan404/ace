// SPDX-License-Identifier: Apache-2.0
//! Encoder settings as a plan, applied all-or-nothing. Pure: the session is
//! behind [`Sink`], so the rollback rule is tested without VideoToolbox.
use media_codec::{CodecError, EncodeSpec, RateControl};

/// The QP range that means "no constraint" for 8-bit H.264 and HEVC.
pub(crate) const QP_OPEN: (u8, u8) = (0, 51);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Setting {
    FrameRate(u32),
    /// 0 is VideoToolbox's default: the encoder chooses.
    Bitrate(u32),
    MinQp(u8),
    MaxQp(u8),
}

pub(crate) trait Sink {
    fn apply(&mut self, setting: Setting) -> Result<(), CodecError>;
}

/// What to set to move from `previous`'s rate mode to `spec`. Leaving a mode
/// resets its properties: a quantizer's bounds open fully, a bitrate goes
/// back to the encoder's choice.
pub(crate) fn plan(previous: Option<RateControl>, spec: &EncodeSpec) -> Vec<Setting> {
    let mut plan = vec![Setting::FrameRate(spec.fps)];
    match (previous, spec.rate) {
        (Some(RateControl::Quantizer(_)), RateControl::Bitrate(_)) => {
            plan.extend([Setting::MinQp(QP_OPEN.0), Setting::MaxQp(QP_OPEN.1)]);
        }
        (Some(RateControl::Bitrate(_)), RateControl::Quantizer(_)) => {
            plan.push(Setting::Bitrate(0));
        }
        _ => {}
    }
    match spec.rate {
        RateControl::Bitrate(bits) => plan.push(Setting::Bitrate(bits)),
        RateControl::Quantizer(qp) => plan.extend([Setting::MinQp(qp), Setting::MaxQp(qp)]),
    }
    plan
}

/// Applies `spec` over `previous`. On a failure, `previous` is applied again
/// (best effort) so the session runs as it did, and the error is returned.
pub(crate) fn apply(
    sink: &mut dyn Sink,
    previous: Option<&EncodeSpec>,
    spec: &EncodeSpec,
) -> Result<(), CodecError> {
    for setting in plan(previous.map(|p| p.rate), spec) {
        if let Err(error) = sink.apply(setting) {
            if let Some(previous) = previous {
                for setting in plan(Some(spec.rate), previous) {
                    let _ = sink.apply(setting);
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_codec::{Codec, Size};

    /// A session's effective settings; fails the `fail_at`-th apply.
    #[derive(Default)]
    struct Session {
        fps: u32,
        bitrate: u32,
        qp: (u8, u8),
        applied: usize,
        fail_at: Option<usize>,
    }
    impl Sink for Session {
        fn apply(&mut self, setting: Setting) -> Result<(), CodecError> {
            self.applied += 1;
            if self.fail_at == Some(self.applied) {
                return Err(CodecError::Backend("refused".into()));
            }
            match setting {
                Setting::FrameRate(fps) => self.fps = fps,
                Setting::Bitrate(bits) => self.bitrate = bits,
                Setting::MinQp(qp) => self.qp.0 = qp,
                Setting::MaxQp(qp) => self.qp.1 = qp,
            }
            Ok(())
        }
    }
    fn spec(fps: u32, rate: RateControl) -> EncodeSpec {
        EncodeSpec {
            codec: Codec::H264,
            size: Size {
                width: 640,
                height: 400,
            },
            fps,
            rate,
        }
    }
    fn opened(spec: &EncodeSpec) -> Session {
        let mut session = Session {
            qp: QP_OPEN,
            ..Session::default()
        };
        let _ = apply(&mut session, None, spec);
        session
    }

    #[test]
    fn a_refusal_at_any_step_leaves_the_previous_configuration_in_force() {
        let old = spec(30, RateControl::Bitrate(2_000_000));
        let new = spec(60, RateControl::Quantizer(30));
        for step in 1..=plan(Some(old.rate), &new).len() {
            let mut session = opened(&old);
            session.fail_at = Some(session.applied + step);
            assert!(apply(&mut session, Some(&old), &new).is_err());
            assert_eq!(
                (session.fps, session.bitrate, session.qp),
                (30, 2_000_000, QP_OPEN),
                "refused at step {step}"
            );
        }
    }

    #[test]
    fn switching_from_quantizer_to_bitrate_opens_the_qp_bounds() {
        let old = spec(60, RateControl::Quantizer(40));
        let mut session = opened(&old);
        assert_eq!(session.qp, (40, 40));
        assert!(
            apply(
                &mut session,
                Some(&old),
                &spec(60, RateControl::Bitrate(8_000_000))
            )
            .is_ok()
        );
        assert_eq!((session.bitrate, session.qp), (8_000_000, QP_OPEN));
    }

    #[test]
    fn switching_from_bitrate_to_quantizer_drops_the_target_bitrate() {
        let old = spec(60, RateControl::Bitrate(8_000_000));
        let mut session = opened(&old);
        assert!(
            apply(
                &mut session,
                Some(&old),
                &spec(60, RateControl::Quantizer(28))
            )
            .is_ok()
        );
        assert_eq!((session.bitrate, session.qp), (0, (28, 28)));
    }
}
