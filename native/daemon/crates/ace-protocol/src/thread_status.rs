// SPDX-License-Identifier: Apache-2.0
//! `ThreadStatus` as `packages/protocol/src/thread-status.ts` defines it: a known status, or a
//! state this client does not know, which Zod's `.transform()` reads as `unknown` and keeps in
//! `raw`. The JSON Schema cannot state that output (it is unconstrained), so typify emits a
//! flattened struct that cannot serialize back; this type is typify's replacement for it.

use serde::Deserialize;
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::ser::{Serialize, SerializeStruct, Serializer};
use std::fmt;

use crate::generated::KnownThreadStatus;

/// A thread's status: one this client knows, or one it doesn't, kept as sent.
#[derive(Clone, Debug)]
pub enum ThreadStatus {
    Known(KnownThreadStatus),
    Unknown { raw: ace_json::Value },
}

impl Serialize for ThreadStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Known(status) => status.serialize(serializer),
            Self::Unknown { raw } => {
                let mut out = serializer.serialize_struct("ThreadStatus", 2)?;
                out.serialize_field("state", "unknown")?;
                out.serialize_field("raw", raw)?;
                out.end()
            }
        }
    }
}

/// What decoding reads: a known status, or any value whose `state` is a string.
enum Repr {
    Known(KnownThreadStatus),
    Raw(ace_json::Value),
}

impl<'de> de::Deserialize<'de> for Repr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ReprVisitor;
        impl<'de> Visitor<'de> for ReprVisitor {
            type Value = Repr;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a thread status")
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Repr, A::Error> {
                // Serde has no untagged derive for a hand-written enum; the map is buffered
                // into a value once and read both ways.
                let value =
                    ace_json::Value::deserialize(de::value::MapAccessDeserializer::new(map))
                        .map_err(de::Error::custom)?;
                match ace_json::from_value::<KnownThreadStatus>(&value) {
                    Ok(known) => Ok(Repr::Known(known)),
                    Err(_) => Ok(Repr::Raw(value)),
                }
            }
        }
        deserializer.deserialize_map(ReprVisitor)
    }
}

impl<'de> de::Deserialize<'de> for ThreadStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Repr::deserialize(deserializer)? {
            Repr::Known(known) => Ok(Self::Known(known)),
            Repr::Raw(raw) => {
                let state = raw.get("state").and_then(|state| match state {
                    ace_json::Value::String(text) => Some(text.as_str().to_string()),
                    _ => None,
                });
                let Some(state) = state else {
                    return Err(de::Error::custom("a status needs a string state"));
                };
                if is_known_state(&state) {
                    return Err(de::Error::custom("a known status did not decode"));
                }
                // The shape table already normalized an unknown status to Zod's output
                // `{ state: "unknown", raw }`; the typed value keeps the inner `raw`.
                if state == "unknown"
                    && let Some(inner) = raw.get("raw")
                {
                    return Ok(Self::Unknown { raw: inner.clone() });
                }
                Ok(Self::Unknown { raw })
            }
        }
    }
}

fn is_known_state(state: &str) -> bool {
    matches!(
        state,
        "needs_you"
            | "working"
            | "waiting"
            | "limited"
            | "failed"
            | "unresponsive"
            | "moved"
            | "done"
            | "new"
    )
}
