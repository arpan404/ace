// SPDX-License-Identifier: Apache-2.0
//! Socket liveness, close-log filtering (`apps/daemon/src/socket-liveness.ts`) and bounded
//! graceful close (`apps/daemon/src/server-socket-close.ts`).

use std::collections::HashMap;
use std::hash::Hash;

use ace_json::Value;

/// Maximum byte length of a `ping` liveness frame (`pingBytes`).
pub const PING_MAX_BYTES: usize = 64;
/// Bound for a deliberate close frame to reach its peer before the socket is dropped.
pub const DAEMON_CLOSE_GRACE_MS: u64 = 1_000;

/// A text frame that is exactly a `ping`: small (<= 64 bytes), and strictly `{"type":"ping"}`.
pub fn is_ping(data: &[u8]) -> bool {
    if data.len() > PING_MAX_BYTES {
        return false;
    }
    let Ok(text) = std::str::from_utf8(data) else {
        return false;
    };
    let Ok(Value::Object(map)) = ace_json::parse(text) else {
        return false;
    };
    map.len() == 1
        && matches!(
            map.get("type"),
            Some(Value::String(kind)) if kind.as_str() == "ping"
        )
}

/// Which kind of client a socket belongs to, from its User-Agent alone. Never an identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientAgent {
    Desktop,
    Ios,
    Android,
    Browser,
    Node,
    Other,
    Unknown,
}

impl ClientAgent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Ios => "ios",
            Self::Android => "android",
            Self::Browser => "browser",
            Self::Node => "node",
            Self::Other => "other",
            Self::Unknown => "unknown",
        }
    }
}

fn has_word_prefix(haystack: &str, token: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(token) {
        let idx = start + pos;
        let boundary =
            idx == 0 || !bytes[idx - 1].is_ascii_alphanumeric() && bytes[idx - 1] != b'_';
        if boundary {
            return true;
        }
        start = idx + 1;
    }
    false
}

/// Classify a client from its User-Agent header (`clientAgent`).
pub fn client_agent(user_agent: Option<&str>) -> ClientAgent {
    let Some(ua) = user_agent.filter(|s| !s.is_empty()) else {
        return ClientAgent::Node;
    };
    if has_word_prefix(ua, "Electron/") {
        return ClientAgent::Desktop;
    }
    if (has_word_prefix(ua, "CFNetwork/") || has_word_prefix(ua, "Darwin/"))
        && !ua.contains("Mozilla/")
    {
        return ClientAgent::Ios;
    }
    if has_word_prefix(ua, "okhttp/") || has_word_prefix(ua, "Dalvik/") {
        return ClientAgent::Android;
    }
    if ua.starts_with("Mozilla/") {
        return ClientAgent::Browser;
    }
    ClientAgent::Other
}

/// What a close record says about the peer; nothing here identifies a person or device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClosePeer {
    pub client: ClientAgent,
    pub access: Option<&'static str>,
    pub channel: Option<String>,
    pub remote: bool,
    pub route: Option<&'static str>,
}

/// Log record for a WebSocket close worth explaining.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloseRecord {
    pub code: u16,
    pub reason: String,
    pub duration_ms: i64,
    pub authenticated: bool,
    pub peer: ClosePeer,
}

fn slice_utf16(text: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = ch.len_utf16();
        if used + w > max_units {
            break;
        }
        used += w;
        out.push(ch);
    }
    out
}

/// Filter and shape a close event for logging (`closeRecord`).
pub fn close_record(
    code: u16,
    reason: &[u8],
    duration_ms: i64,
    authenticated: bool,
    peer: ClosePeer,
) -> Option<CloseRecord> {
    if !authenticated && code < 4000 {
        return None;
    }
    let ordinary = matches!(code, 1000 | 1001 | 1005);
    if ordinary && peer.route != Some("relay") {
        return None;
    }
    let text = String::from_utf8_lossy(reason);
    Some(CloseRecord {
        code,
        reason: slice_utf16(&text, 123),
        duration_ms: duration_ms.max(0),
        authenticated,
        peer,
    })
}

/// Ready state of a WebSocket as `SocketCloser` inspects it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadyState {
    Connecting = 0,
    Open = 1,
    Closing = 2,
    Closed = 3,
}

/// Wire action `SocketCloser` instructs the shell to take.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseAction {
    None,
    SendClose { code: u16, reason: String },
    Terminate,
}

#[derive(Clone, Copy, Debug)]
struct Grace {
    close_sent: bool,
    deadline_ms: u64,
}

/// Bounded graceful close state machine (`createSocketCloser` in `server-socket-close.ts`).
#[derive(Clone, Debug)]
pub struct SocketCloser<K> {
    grace_ms: u64,
    pending: HashMap<K, Grace>,
}

impl<K: Eq + Hash + Clone> SocketCloser<K> {
    pub fn new(grace_ms: u64) -> Self {
        Self {
            grace_ms,
            pending: HashMap::new(),
        }
    }

    /// Send `code`/`reason` when open and arm the drop deadline; idempotent once close is sent.
    pub fn graceful_close(
        &mut self,
        socket: K,
        state: ReadyState,
        code: u16,
        reason: &str,
        now_ms: u64,
    ) -> CloseAction {
        if self.pending.get(&socket).is_some_and(|g| g.close_sent) {
            return CloseAction::None;
        }
        match state {
            ReadyState::Open => {
                self.arm(socket, true, now_ms);
                CloseAction::SendClose {
                    code,
                    reason: reason.to_owned(),
                }
            }
            ReadyState::Closing | ReadyState::Connecting => {
                self.arm(socket, false, now_ms);
                CloseAction::None
            }
            ReadyState::Closed => CloseAction::None,
        }
    }

    /// Error path's share of the same bound (`boundClosingSocket`).
    pub fn bound_closing(&mut self, socket: K, state: ReadyState, now_ms: u64) -> CloseAction {
        match state {
            ReadyState::Closing => {
                self.arm(socket, false, now_ms);
                CloseAction::None
            }
            ReadyState::Closed => CloseAction::None,
            ReadyState::Connecting | ReadyState::Open => {
                self.pending.remove(&socket);
                CloseAction::Terminate
            }
        }
    }

    /// The socket emitted `close`: cancel its pending grace deadline.
    pub fn on_closed(&mut self, socket: &K) {
        self.pending.remove(socket);
    }

    /// Return all sockets whose close-grace deadline has expired at `now_ms`, removing them.
    pub fn drain_expired(&mut self, now_ms: u64) -> Vec<K> {
        let expired: Vec<K> = self
            .pending
            .iter()
            .filter(|(_, grace)| now_ms >= grace.deadline_ms)
            .map(|(k, _)| k.clone())
            .collect();
        for key in &expired {
            self.pending.remove(key);
        }
        expired
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    fn arm(&mut self, socket: K, close_sent: bool, now_ms: u64) {
        let deadline_ms = now_ms.saturating_add(self.grace_ms);
        if let Some(existing) = self.pending.get_mut(&socket) {
            if close_sent && !existing.close_sent {
                existing.close_sent = true;
                existing.deadline_ms = deadline_ms;
            }
            return;
        }
        self.pending.insert(
            socket,
            Grace {
                close_sent,
                deadline_ms,
            },
        );
    }
}
