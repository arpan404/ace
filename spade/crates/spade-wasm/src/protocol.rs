//! What Spade and its `spade-wasm` worker say to each other over the pipe (ADR 0203 §3): Spade
//! loads components and starts calls; the worker asks Spade for every `tools`, `http` and `kv`
//! call a component makes, and answers each call once, done or cut off. Both ends are Spade's,
//! so nothing here is read leniently; a frame that doesn't parse ends the pipe.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use spade_core::package::code::Bounds;

/// Spade to the worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToWorker {
    /// Compile the component in `path` (inside the worker's folder), whose bytes hash to
    /// `component` (sha256, hex); the worker checks the hash before it compiles.
    Load { component: String, path: PathBuf },
    /// Run `target` of a loaded component, within `bounds`.
    Call {
        id: u64,
        component: String,
        target: Target,
        input: String,
        bounds: Bounds,
    },
    /// Spade's answer to the worker's `request` for call `id`.
    Reply {
        id: u64,
        request: u64,
        answer: Answer,
    },
    /// End call `id` now, or every call when `None`.
    Stop { id: Option<u64> },
}

/// What a call runs in the component's `toolbox`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    /// `toolbox.tools`: the JSON list of its tools.
    Tools,
    /// `toolbox.call` with this tool's name.
    Tool { name: String },
}

/// Something a component asked of Spade, which Spade carries out after its gate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostRequest {
    /// `spade:package/tools.call`: one of the bot's `spade.v1` tools, as the bot.
    Tools {
        name: String,
        input: String,
    },
    /// `spade:package/http.send`: one https request through the bot's egress proxy.
    Http {
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        #[serde(with = "bytes")]
        body: Vec<u8>,
    },
    /// `spade:package/kv`: the package's store on this bot.
    KvGet {
        key: String,
    },
    KvSet {
        key: String,
        #[serde(with = "bytes")]
        value: Vec<u8>,
    },
    KvDelete {
        key: String,
    },
    KvKeys {
        prefix: String,
    },
}

/// Spade's answer to a [`HostRequest`]: its value, or why there is none, in a sentence.
pub type Answer = Result<HostValue, String>;

/// The value of an answered request, of the request's kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostValue {
    /// A tool's output.
    Json {
        json: String,
    },
    Response {
        status: u16,
        headers: Vec<(String, String)>,
        #[serde(with = "bytes")]
        body: Vec<u8>,
    },
    Value {
        #[serde(with = "optional_bytes")]
        value: Option<Vec<u8>>,
    },
    Keys {
        keys: Vec<String>,
    },
    /// A set or delete that was done.
    Done,
}

/// The worker to Spade.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromWorker {
    /// Started, with the runtime it runs on.
    Ready {
        wasmtime: String,
    },
    Loaded {
        component: String,
    },
    LoadFailed {
        component: String,
        reason: String,
    },
    /// Call `id`'s component asks Spade for `call`; the call waits for the [`ToWorker::Reply`].
    Host {
        id: u64,
        request: u64,
        call: HostRequest,
    },
    /// Call `id` answered. `output` is the component's own answer: its value or its failure.
    Done {
        id: u64,
        output: Result<String, String>,
        stats: Stats,
        logs: Vec<String>,
    },
    /// Call `id` gave no answer: it was cut off or trapped.
    Failed {
        id: u64,
        cut: Cut,
        message: String,
        stats: Stats,
        logs: Vec<String>,
    },
}

/// What one call used, stored on its step (ADR 0203 §4).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stats {
    /// Time the component ran, waits on Spade not counted.
    pub run_ms: u64,
    pub fuel: u64,
    /// The largest its linear memory grew to.
    pub peak_memory: u64,
}

/// Why a call gave no answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cut {
    /// It ran past its deadline.
    Deadline,
    /// It ran out of fuel: a tight loop that never yields.
    Fuel,
    /// It grew its memory past its bound.
    Memory,
    /// It trapped on its own.
    Trap,
    /// Stop or Pause ended it.
    Stopped,
    /// The worker couldn't start it: no such component, or four calls already run.
    Refused,
    /// The worker died with the call open: whatever it did is unknown, never done.
    Lost,
}

/// Bytes as base64 text.
mod bytes {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}

mod optional_bytes {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(bytes) => s.serialize_some(&STANDARD.encode(bytes)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        match Option::<String>::deserialize(d)? {
            Some(text) => STANDARD
                .decode(text)
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}
