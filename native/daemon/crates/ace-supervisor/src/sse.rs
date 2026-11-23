// SPDX-License-Identifier: Apache-2.0
//! Incremental Server-Sent Events framing for `SseParser` (`sse-parser.ts`).
//! CR, LF and a split CRLF all end a line; comments are ignored; `data` lines
//! join with LF; `event`, `id` and `retry` are read with today's rules (an `id`
//! holding NUL is ignored, `retry` is digits only and a safe integer). The line
//! and event byte budgets are checked before a character is retained.
//!
//! The field split follows today's rule exactly (`field: value`, one optional space
//! after the colon); `eventsource-stream` exposes only its async transport, so its
//! line parser is not reused here.

/// Largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// One dispatched event (`SseEvent`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub data: String,
    pub event: String,
    pub id: String,
}

/// A parser with today's state: the last dispatched id, the last retry read, and
/// the line and event accumulators.
#[derive(Debug)]
pub struct SseParser {
    last_event_id: String,
    retry_ms: Option<f64>,
    line: String,
    line_bytes: usize,
    event_bytes: usize,
    max_line_bytes: usize,
    max_event_bytes: usize,
    skip_lf: bool,
    data: Vec<String>,
    event: String,
    id: String,
}

/// What one `feed` produced: the events to dispatch, in order, then the refusal
/// that stopped it (events before it still dispatch, as they already did).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SseFeed {
    pub events: Vec<SseEvent>,
    pub error: Option<String>,
}

impl SseParser {
    pub fn new(max_line_bytes: usize, max_event_bytes: usize, last_event_id: String) -> SseParser {
        SseParser {
            last_event_id: last_event_id.clone(),
            retry_ms: None,
            line: String::new(),
            line_bytes: 0,
            event_bytes: 0,
            max_line_bytes,
            max_event_bytes,
            skip_lf: false,
            data: Vec::new(),
            event: String::new(),
            id: last_event_id,
        }
    }

    pub fn last_event_id(&self) -> &str {
        &self.last_event_id
    }

    pub fn retry_ms(&self) -> Option<f64> {
        self.retry_ms
    }

    /// Feed decoded text, returning the events it completed.
    pub fn feed(&mut self, text: &str) -> SseFeed {
        let mut out = SseFeed::default();
        let bytes = text.as_bytes();
        let mut start = 0usize;
        let mut index = 0usize;
        while index < bytes.len() {
            let byte = bytes[index];
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    start = index + 1;
                    index += 1;
                    continue;
                }
            }
            if byte != b'\r' && byte != b'\n' {
                index += 1;
                continue;
            }
            if let Err(message) = self.append(&text[start..index]) {
                out.error = Some(message);
                return out;
            }
            let line = std::mem::take(&mut self.line);
            self.line_bytes = 0;
            if let Err(message) = self.accept(&line, &mut out.events) {
                out.error = Some(message);
                return out;
            }
            self.skip_lf = byte == b'\r';
            start = index + 1;
            index += 1;
        }
        if let Err(message) = self.append(&text[start..]) {
            out.error = Some(message);
        }
        out
    }

    fn append(&mut self, text: &str) -> Result<(), String> {
        self.line_bytes += text.len();
        if self.line_bytes > self.max_line_bytes {
            return Err("SSE line exceeded limit".to_owned());
        }
        self.line.push_str(text);
        Ok(())
    }

    fn accept(&mut self, line: &str, events: &mut Vec<SseEvent>) -> Result<(), String> {
        if line.is_empty() {
            self.last_event_id.clone_from(&self.id);
            if !self.data.is_empty() {
                events.push(SseEvent {
                    data: self.data.join("\n"),
                    event: if self.event.is_empty() {
                        "message".to_owned()
                    } else {
                        self.event.clone()
                    },
                    id: self.last_event_id.clone(),
                });
            }
            self.data.clear();
            self.event_bytes = 0;
            self.event.clear();
            return Ok(());
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = split_field(line);
        self.apply(field, value)
    }

    fn apply(&mut self, field: &str, value: &str) -> Result<(), String> {
        match field {
            "data" => {
                self.event_bytes += value.len() + usize::from(!self.data.is_empty());
                if self.event_bytes > self.max_event_bytes {
                    return Err("SSE event exceeded limit".to_owned());
                }
                self.data.push(value.to_owned());
            }
            "event" => self.event = value.to_owned(),
            "id" if !value.contains('\0') => self.id = value.to_owned(),
            "retry" => {
                if let Some(retry) = parse_retry(value) {
                    self.retry_ms = Some(retry);
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// `field: value`, with the one optional space after the colon removed.
fn split_field(line: &str) -> (&str, &str) {
    let Some(colon) = line.find(':') else {
        return (line, "");
    };
    let field = &line[..colon];
    let rest = &line[colon + 1..];
    let value = rest.strip_prefix(' ').unwrap_or(rest);
    (field, value)
}

/// `retry` as today: digits only, and a number JavaScript holds exactly.
fn parse_retry(value: &str) -> Option<f64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let parsed = value.parse::<f64>().ok()?;
    (parsed.is_finite() && parsed.fract() == 0.0 && parsed <= MAX_SAFE_INTEGER).then_some(parsed)
}
