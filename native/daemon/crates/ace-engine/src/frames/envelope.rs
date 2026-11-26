// SPDX-License-Identifier: Apache-2.0
//! The frame envelope check (`frame-envelope.ts`). ace's own session built the envelope (ADR
//! 0125), so it is checked in place, never parsed into a copy; a bad envelope is an adapter bug
//! that must still fail the session visibly. The binding classifies each JavaScript property
//! into a [`Field`]; a native frame builds the same [`Envelope`] from its typed fields.

use ace_json::JsString;

/// One envelope field as the binding found it on the JavaScript object, or as a native frame
/// has it.
#[derive(Debug, Clone, PartialEq)]
pub enum Field {
    Absent,
    Null,
    Number(f64),
    String(JsString),
    Object,
    Other,
}

/// The frame's `payload`: absent, or a `ProviderPayload` brand check that passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadField {
    Absent,
    Certified,
    NotCertified,
}

/// The frame's `usageAccount`.
#[derive(Debug, Clone, PartialEq)]
pub enum AccountField {
    Absent,
    NotObject,
    Object { id: Field, billing_mode: Field },
}

/// Everything `frameEnvelopeError` reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub is_object: bool,
    pub seq: Field,
    pub t: Field,
    pub dir: Field,
    pub channel: Field,
    pub payload: PayloadField,
    pub usage_account: AccountField,
}

const DIRECTIONS: [&str; 4] = ["send", "recv", "stderr", "note"];
const BILLING_MODES: [&str; 3] = ["api", "subscription", "unknown"];

/// The largest integer a JavaScript number holds exactly (`Number.isSafeInteger`).
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn safe_integer(field: &Field) -> Option<f64> {
    match field {
        Field::Number(value) if value.fract() == 0.0 && value.abs() <= MAX_SAFE => Some(*value),
        _ => None,
    }
}

fn named(field: &Field, names: &[&str]) -> bool {
    match field {
        Field::String(text) => names.contains(&text.as_str()),
        _ => false,
    }
}

/// Why an adapter's frame envelope is malformed, or `None` when it is sound.
pub fn envelope_error(envelope: &Envelope) -> Option<&'static str> {
    if !envelope.is_object {
        return Some("frame");
    }
    match safe_integer(&envelope.seq) {
        Some(seq) if seq >= 0.0 => {}
        _ => return Some("seq"),
    }
    match &envelope.t {
        Field::Number(t) if t.is_finite() && *t >= 0.0 => {}
        _ => return Some("t"),
    }
    if !named(&envelope.dir, &DIRECTIONS) {
        return Some("dir");
    }
    if !matches!(&envelope.channel, Field::String(_)) {
        return Some("channel");
    }
    if envelope.payload == PayloadField::NotCertified {
        return Some("payload");
    }
    match &envelope.usage_account {
        AccountField::Absent => {}
        AccountField::NotObject => return Some("usageAccount"),
        AccountField::Object { id, billing_mode } => {
            let length = match id {
                Field::String(text) => Some(text.len_utf16()),
                _ => None,
            };
            if !matches!(length, Some(1..=512)) {
                return Some("usageAccount.id");
            }
            if !named(billing_mode, &BILLING_MODES) {
                return Some("usageAccount.billingMode");
            }
        }
    }
    None
}

// E5.2's own envelope for a native frame, built from its typed fields.
impl From<&ace_adapter_api::Frame> for Envelope {
    fn from(frame: &ace_adapter_api::Frame) -> Envelope {
        use ace_adapter_api::FrameDirection;
        let dir = match frame.dir {
            FrameDirection::Send => "send",
            FrameDirection::Recv => "recv",
            FrameDirection::Stderr => "stderr",
            FrameDirection::Note => "note",
        };
        Envelope {
            is_object: true,
            seq: Field::Number(frame.seq as f64),
            t: Field::Number(frame.t as f64),
            dir: Field::String(JsString::from(dir)),
            channel: Field::String(JsString::from(frame.channel.as_str())),
            payload: match &frame.payload {
                Some(_) => PayloadField::Certified,
                None => PayloadField::Absent,
            },
            usage_account: match &frame.usage_account {
                None => AccountField::Absent,
                Some(account) => AccountField::Object {
                    id: Field::String(JsString::from(account.id.as_str())),
                    billing_mode: Field::String(JsString::from(match account.billing_mode {
                        ace_adapter_api::BillingMode::Api => "api",
                        ace_adapter_api::BillingMode::Subscription => "subscription",
                        ace_adapter_api::BillingMode::Unknown => "unknown",
                    })),
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AccountField, Envelope, Field, PayloadField, envelope_error};
    use ace_json::JsString;

    fn text(value: &str) -> Field {
        Field::String(JsString::from(value))
    }

    fn frame() -> Envelope {
        Envelope {
            is_object: true,
            seq: Field::Number(0.0),
            t: Field::Number(0.0),
            dir: text("recv"),
            channel: text("stdio"),
            payload: PayloadField::Absent,
            usage_account: AccountField::Absent,
        }
    }

    fn accepts(name: &str, envelope: Envelope) {
        assert_eq!(envelope_error(&envelope), None, "accepts {name}");
    }

    fn rejects(name: &str, envelope: Envelope, field: &str) {
        assert_eq!(envelope_error(&envelope), Some(field), "rejects {name}");
    }

    #[test]
    fn a_usage_account_id_accepts_512_utf16_units_and_refuses_513() {
        let with_account = |id: &str| Envelope {
            usage_account: AccountField::Object {
                id: text(id),
                billing_mode: text("api"),
            },
            ..frame()
        };
        let suffix = "😀";
        accepts(
            "512 UTF-16 units",
            with_account(&format!("{}{suffix}", "a".repeat(510))),
        );
        rejects(
            "513 UTF-16 units",
            with_account(&format!("{}{suffix}", "a".repeat(511))),
            "usageAccount.id",
        );
    }

    #[test]
    fn the_accepted_envelopes_are_sound() {
        accepts("a plain frame", frame());
        accepts(
            "a frame with its admission certificate",
            Envelope {
                payload: PayloadField::Certified,
                ..frame()
            },
        );
        accepts(
            "a frame with a usage account",
            Envelope {
                usage_account: AccountField::Object {
                    id: text("acct"),
                    billing_mode: text("api"),
                },
                ..frame()
            },
        );
        accepts(
            "a frame with no data",
            Envelope {
                seq: Field::Number(9.0),
                t: Field::Number(1.5),
                dir: text("note"),
                ..frame()
            },
        );
    }

    #[test]
    fn each_malformed_envelope_names_its_field() {
        rejects(
            "no envelope at all",
            Envelope {
                is_object: false,
                ..frame()
            },
            "frame",
        );
        rejects(
            "a negative sequence",
            Envelope {
                seq: Field::Number(-1.0),
                ..frame()
            },
            "seq",
        );
        rejects(
            "a fractional sequence",
            Envelope {
                seq: Field::Number(1.5),
                ..frame()
            },
            "seq",
        );
        rejects(
            "an unsafe sequence",
            Envelope {
                seq: Field::Number(9_007_199_254_740_992.0),
                ..frame()
            },
            "seq",
        );
        rejects(
            "a negative time",
            Envelope {
                t: Field::Number(-1.0),
                ..frame()
            },
            "t",
        );
        rejects(
            "a time that is not finite",
            Envelope {
                t: Field::Number(f64::NAN),
                ..frame()
            },
            "t",
        );
        rejects(
            "an unknown direction",
            Envelope {
                dir: text("sideways"),
                ..frame()
            },
            "dir",
        );
        rejects(
            "a missing channel",
            Envelope {
                channel: Field::Absent,
                ..frame()
            },
            "channel",
        );
        rejects(
            "a certificate ace did not make",
            Envelope {
                payload: PayloadField::NotCertified,
                ..frame()
            },
            "payload",
        );
        rejects(
            "an empty account id",
            Envelope {
                usage_account: AccountField::Object {
                    id: text(""),
                    billing_mode: text("api"),
                },
                ..frame()
            },
            "usageAccount.id",
        );
        rejects(
            "an unknown billing mode",
            Envelope {
                usage_account: AccountField::Object {
                    id: text("a"),
                    billing_mode: text("free"),
                },
                ..frame()
            },
            "usageAccount.billingMode",
        );
    }
}
