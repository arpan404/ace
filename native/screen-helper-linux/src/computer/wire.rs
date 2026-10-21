//! `--computer` speaks JSON lines: `{id, op, ...}` in, `{id, ok:true, result}` or
//! `{id, ok:false, error:{code, message}}` out. Pure: framing, parsing and reply encoding.
use serde_json::{Map, Value, json};

pub const REQUEST_LIMIT: usize = 8 * 1024 * 1024;
/// Bytes of an over-long line kept, enough to find its id.
const KEEP: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum Framed {
    Line(Vec<u8>),
    Overlong(Vec<u8>),
}

/// Splits stdin bytes into lines. A line longer than the limit is never buffered whole: its
/// first bytes are kept, the rest is dropped up to the next newline, and reading carries on.
pub struct LineFramer {
    limit: usize,
    pending: Vec<u8>,
    overflowing: bool,
}

impl LineFramer {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            pending: Vec::new(),
            overflowing: false,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Framed> {
        let mut lines = Vec::new();
        let mut rest = bytes;
        while !rest.is_empty() {
            let newline = rest.iter().position(|b| *b == b'\n');
            let (chunk, ended) = match newline {
                Some(at) => (&rest[..at], true),
                None => (rest, false),
            };
            if !self.overflowing {
                self.pending.extend_from_slice(chunk);
                if self.pending.len() > self.limit {
                    self.overflowing = true;
                    self.pending.truncate(KEEP);
                }
            }
            if ended {
                let line = std::mem::take(&mut self.pending);
                lines.push(if self.overflowing {
                    Framed::Overlong(line)
                } else {
                    Framed::Line(line)
                });
                self.overflowing = false;
                rest = &rest[chunk.len() + 1..];
            } else {
                rest = &[];
            }
        }
        lines
    }
}

#[derive(Debug, PartialEq)]
pub enum RequestLine {
    Request {
        id: String,
        body: Map<String, Value>,
    },
    /// Not a usable request: reply `bad_request` to `id` ("" when no id could be read).
    Invalid {
        id: String,
        message: String,
    },
    Blank,
}

pub fn parse_line(framed: &Framed) -> RequestLine {
    let data = match framed {
        Framed::Overlong(prefix) => {
            return RequestLine::Invalid {
                id: sniff_id(prefix).unwrap_or_default(),
                message: "The request was longer than 8 MB and was discarded.".into(),
            };
        }
        Framed::Line(data) => data,
    };
    if data.iter().all(|b| matches!(b, b' ' | b'\t' | b'\r')) {
        return RequestLine::Blank;
    }
    let Ok(Value::Object(body)) = serde_json::from_slice::<Value>(data) else {
        return RequestLine::Invalid {
            id: sniff_id(data).unwrap_or_default(),
            message: "The request is not a JSON object.".into(),
        };
    };
    let Some(id) = body.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return RequestLine::Invalid {
            id: String::new(),
            message: "The request has no string id.".into(),
        };
    };
    if !body.get("op").is_some_and(Value::is_string) {
        return RequestLine::Invalid {
            id,
            message: "The request has no op.".into(),
        };
    }
    RequestLine::Request { id, body }
}

/// Finds `"id":"…"` near the start of a line that could not be parsed whole.
pub fn sniff_id(data: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(&data[..data.len().min(KEEP)]);
    let after = &text[text.find("\"id\"")? + 4..];
    let after = after.trim_start_matches([' ', '\t']).strip_prefix(':')?;
    let after = after.trim_start_matches([' ', '\t']).strip_prefix('"')?;
    let end = after.find(['"', '\\'])?;
    (after.as_bytes()[end] == b'"').then(|| after[..end].to_owned())
}

pub fn ok_line(id: &str, result: Value) -> String {
    let mut line = json!({"id": id, "ok": true, "result": result}).to_string();
    line.push('\n');
    line
}

pub fn error_line(id: &str, code: &str, message: &str) -> String {
    let mut line = json!({"id": id, "ok": false, "error": {"code": code, "message": message}}).to_string();
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn requests(framer: &mut LineFramer, bytes: &[u8]) -> Vec<RequestLine> {
        framer.feed(bytes).iter().map(parse_line).collect()
    }

    #[test]
    fn lines_split_across_reads_join_into_one_request() {
        let mut framer = LineFramer::new(REQUEST_LIMIT);
        assert!(requests(&mut framer, br#"{"id":"a","o"#).is_empty());
        let parsed = requests(&mut framer, b"p\":\"hello\"}\n\n");
        assert!(matches!(&parsed[0], RequestLine::Request { id, .. } if id == "a"));
        assert_eq!(parsed[1], RequestLine::Blank);
    }

    #[test]
    fn an_overlong_line_fails_by_its_id_and_the_next_request_still_runs() {
        let mut framer = LineFramer::new(64);
        let mut line = br#"{"id":"big","op":"act","text":""#.to_vec();
        line.extend(std::iter::repeat_n(b'x', 500));
        line.extend_from_slice(b"\"}\n{\"id\":\"next\",\"op\":\"hello\"}\n");
        let parsed = requests(&mut framer, &line);
        assert_eq!(
            parsed[0],
            RequestLine::Invalid {
                id: "big".into(),
                message: "The request was longer than 8 MB and was discarded.".into()
            }
        );
        assert!(matches!(&parsed[1], RequestLine::Request { id, .. } if id == "next"));
    }

    #[test]
    fn malformed_requests_say_what_is_wrong() {
        let mut framer = LineFramer::new(REQUEST_LIMIT);
        let parsed = requests(&mut framer, b"{\"id\":\"x\",\n{\"op\":\"hello\"}\n{\"id\":\"y\"}\n");
        assert!(matches!(&parsed[0], RequestLine::Invalid { id, .. } if id == "x"));
        assert!(
            matches!(&parsed[1], RequestLine::Invalid { id, message } if id.is_empty() && message.contains("no string id"))
        );
        assert!(matches!(&parsed[2], RequestLine::Invalid { id, message } if id == "y" && message.contains("no op")));
    }

    #[test]
    fn any_string_id_is_echoed_in_replies() {
        let line = ok_line("weird \"id\"", json!({"x": 1}));
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["id"], "weird \"id\"");
        assert_eq!(value["result"]["x"], 1);
        let failure: Value = serde_json::from_str(&error_line("7", "bad_request", "no")).unwrap();
        assert_eq!(failure["ok"], false);
        assert_eq!(failure["error"]["code"], "bad_request");
    }
}
