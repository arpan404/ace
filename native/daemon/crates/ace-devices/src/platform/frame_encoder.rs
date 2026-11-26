// SPDX-License-Identifier: Apache-2.0
//! `frame-encoder.ts`'s protocol: the screen helper's `--encode-frames` process reads the
//! newest picture in a shared RGBA file with the Mac's hardware encoder and writes units only
//! to ace-media's ingest. Its commands are one JSON object per line on stdin; its word on
//! stderr is one ingest event per line. The process, promises and stderr reading are the
//! shell's.

use serde::Serialize;
use serde_json::Value;

/// The longest partial line kept; anything longer is dropped rather than buffered.
pub const MAX_PARTIAL: usize = 4096;

/// The encoder's word on stderr after an `ingest` command, or when its connection failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestEvent {
    /// It switched where it sends: `boundary` is the last sequence the previous ingest took.
    Switched { ingest: bool, boundary: Option<u64> },
    /// Its ingest connection failed: units stop until a new address.
    Closed,
}

/// One command written to the encoder's stdin.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum EncoderCommand {
    #[serde(rename = "frame")]
    Frame {
        seq: u64,
        width: u32,
        height: u32,
        ts: f64,
    },
    Bitrate {
        bitrate: f64,
    },
    Keyframe,
    Ingest {
        #[serde(skip_serializing_if = "Option::is_none")]
        socket: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
}

/// The address an ingest command names: ace-media's socket and the base64 token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestAddress {
    pub socket: String,
    pub token: String,
}

impl EncoderCommand {
    pub fn ingest(address: Option<&IngestAddress>) -> Self {
        match address {
            Some(address) => Self::Ingest {
                socket: Some(address.socket.clone()),
                token: Some(address.token.clone()),
            },
            None => Self::Ingest {
                socket: None,
                token: None,
            },
        }
    }

    /// The line the shell writes, newline included.
    pub fn line(&self) -> String {
        let mut text = serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string());
        text.push('\n');
        text
    }
}

/// One stderr line as an event, or `None` for anything that is not the schema's object.
pub fn parse_ingest_event(line: &str) -> Option<IngestEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    if object.get("event")?.as_str()? != "ingest" {
        return None;
    }
    let state = object.get("state")?.as_str()?;
    if state == "closed" {
        return Some(IngestEvent::Closed);
    }
    let ingest = match state {
        "on" => true,
        "off" => false,
        _ => return None,
    };
    let boundary = match object.get("boundary") {
        None => return None,
        Some(Value::Null) => None,
        Some(value) => {
            let number = value.as_f64()?;
            if !number.is_finite() || number.fract() != 0.0 || number < 0.0 {
                return None;
            }
            // A JS number is exact only to 2^53 - 1; `z.number().int()` takes no further.
            if number > 9_007_199_254_740_991.0 {
                return None;
            }
            Some(number as u64)
        }
    };
    Some(IngestEvent::Switched { ingest, boundary })
}

/// stderr split into lines: a line longer than any event is dropped rather than buffered.
#[derive(Debug, Default)]
pub struct Lines {
    partial: String,
}

impl Lines {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds one chunk of stderr text and returns every complete line it finished.
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        let joined = format!("{}{chunk}", self.partial);
        let mut parts: Vec<String> = joined.split('\n').map(str::to_string).collect();
        self.partial = parts.pop().unwrap_or_default();
        if utf16_len(&self.partial) > MAX_PARTIAL {
            self.partial.clear();
        }
        parts
    }
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ingest_event_is_the_schemas_object_and_anything_else_is_ignored() {
        assert_eq!(
            parse_ingest_event(r#"{"event":"ingest","state":"on","boundary":7}"#),
            Some(IngestEvent::Switched {
                ingest: true,
                boundary: Some(7)
            })
        );
        assert_eq!(
            parse_ingest_event(r#"{"event":"ingest","state":"off","boundary":null}"#),
            Some(IngestEvent::Switched {
                ingest: false,
                boundary: None
            })
        );
        assert_eq!(
            parse_ingest_event(r#"{"event":"ingest","state":"closed","boundary":null}"#),
            Some(IngestEvent::Closed)
        );
        for line in [
            "not json",
            r#"{"event":"other","state":"on","boundary":1}"#,
            r#"{"event":"ingest","state":"maybe","boundary":1}"#,
            r#"{"event":"ingest","state":"on"}"#,
            r#"{"event":"ingest","state":"on","boundary":-1}"#,
            r#"{"event":"ingest","state":"on","boundary":1.5}"#,
        ] {
            assert_eq!(parse_ingest_event(line), None, "{line}");
        }
    }

    #[test]
    fn commands_are_one_json_object_per_line_in_the_shape_the_encoder_reads() {
        assert_eq!(
            EncoderCommand::Frame {
                seq: 3,
                width: 1206,
                height: 2622,
                ts: 1_234.5
            }
            .line(),
            "{\"op\":\"frame\",\"seq\":3,\"width\":1206,\"height\":2622,\"ts\":1234.5}\n"
        );
        assert_eq!(
            EncoderCommand::Bitrate {
                bitrate: 8_000_000.0
            }
            .line(),
            "{\"op\":\"bitrate\",\"bitrate\":8000000.0}\n"
        );
        assert_eq!(EncoderCommand::Keyframe.line(), "{\"op\":\"keyframe\"}\n");
        assert_eq!(
            EncoderCommand::ingest(Some(&IngestAddress {
                socket: "/run/m1i.sock".to_string(),
                token: "dG9rZW4=".to_string()
            }))
            .line(),
            "{\"op\":\"ingest\",\"socket\":\"/run/m1i.sock\",\"token\":\"dG9rZW4=\"}\n"
        );
        assert_eq!(EncoderCommand::ingest(None).line(), "{\"op\":\"ingest\"}\n");
    }

    #[test]
    fn stderr_is_split_into_lines_and_a_line_over_the_bound_is_dropped() {
        let mut lines = Lines::new();
        assert!(lines.push("{\"a\":1}").is_empty());
        assert_eq!(
            lines.push("}\n{\"b\":2}\n{\"c\""),
            vec!["{\"a\":1}}", "{\"b\":2}"]
        );
        assert_eq!(lines.push(":3}\n"), vec!["{\"c\":3}"]);
        let mut long = Lines::new();
        let chunk = "x".repeat(MAX_PARTIAL + 1);
        assert!(long.push(&chunk).is_empty());
        assert_eq!(
            long.push("\nrest\n"),
            vec!["", "rest"],
            "the long line is gone; the empty line parses as nothing"
        );
    }
}
