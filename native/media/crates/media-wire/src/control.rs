pub use crate::capability::{Acceleration, Backend, Capability, SourceStep, Step, TrialState};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Setting {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "legacy")]
    Legacy,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Status {
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "playing")]
    Playing,
    #[serde(rename = "retrying")]
    Retrying,
    #[serde(rename = "ended")]
    Ended,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum KeyReason {
    #[serde(rename = "viewer")]
    Viewer,
    #[serde(rename = "drop")]
    Drop,
    #[serde(rename = "resume")]
    Resume,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum CutReason {
    #[serde(rename = "size")]
    Size,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ConnectionKind {
    #[serde(rename = "direct")]
    Direct,
    #[serde(rename = "relay")]
    Relay,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Refusal {
    #[serde(rename = "owner")]
    Owner,
    #[serde(rename = "revoked")]
    Revoked,
    #[serde(rename = "expired")]
    Expired,
    #[serde(rename = "unknown-connection")]
    UnknownConnection,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Level {
    #[serde(rename = "debug")]
    Debug,
    #[serde(rename = "info")]
    Info,
    #[serde(rename = "warn")]
    Warn,
    #[serde(rename = "error")]
    Error,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Id(String);
impl Id {
    pub fn new(value: String) -> Result<Self, &'static str> {
        if value.chars().count() > 64 {
            return Err("identifier too long");
        }
        Ok(Self(value))
    }
    pub fn get(&self) -> &str {
        &self.0
    }
}
impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Admission {
    #[serde(rename = "pairing")]
    Pairing {
        #[serde(rename = "generation")]
        generation: Sequence,
    },
    #[serde(rename = "account")]
    Account {
        #[serde(rename = "account")]
        account: Id,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Origin {
    #[serde(rename = "tab")]
    Tab {},
    #[serde(rename = "tab-pictures")]
    TabPictures {},
    #[serde(rename = "user-tab")]
    UserTab {},
    #[serde(rename = "embedded")]
    Embedded {},
    #[serde(rename = "screen")]
    Screen {
        #[serde(rename = "platform")]
        platform: String,
    },
    #[serde(rename = "simulator")]
    Simulator {
        #[serde(rename = "streamUrl")]
        stream_url: String,
        #[serde(rename = "stillUrl")]
        still_url: String,
    },
    #[serde(rename = "scrcpy")]
    Scrcpy {
        #[serde(rename = "host")]
        host: String,
        #[serde(rename = "port")]
        port: u32,
    },
    #[serde(rename = "emulator-frames")]
    EmulatorFrames {
        #[serde(rename = "path")]
        path: String,
        #[serde(rename = "width")]
        width: u32,
        #[serde(rename = "height")]
        height: u32,
        #[serde(rename = "stride")]
        stride: u32,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Owner {
    #[serde(rename = "session")]
    pub session: Id,
    #[serde(rename = "device")]
    pub device: Id,
    #[serde(rename = "admission")]
    pub admission: Admission,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "recordings")]
    pub recordings: Setting,
    #[serde(rename = "stills")]
    pub stills: Setting,
    #[serde(rename = "encode")]
    pub encode: Setting,
    #[serde(rename = "delivery")]
    pub delivery: Setting,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remote {
    #[serde(rename = "addresses")]
    pub addresses: Vec<String>,
    #[serde(rename = "port")]
    pub port: u32,
    #[serde(rename = "certificateBytes")]
    pub certificate_bytes: u32,
    #[serde(rename = "keyBytes")]
    pub key_bytes: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    #[serde(rename = "width")]
    pub width: u32,
    #[serde(rename = "height")]
    pub height: u32,
    #[serde(rename = "dpr")]
    pub dpr: Nonnegative,
    #[serde(rename = "scale")]
    pub scale: Nonnegative,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EncodeSpec {
    #[serde(rename = "id")]
    pub id: u32,
    #[serde(rename = "codec")]
    pub codec: String,
    #[serde(rename = "width")]
    pub width: u32,
    #[serde(rename = "height")]
    pub height: u32,
    #[serde(rename = "fps")]
    pub fps: u32,
    #[serde(rename = "bitrate")]
    pub bitrate: u32,
    #[serde(
        rename = "quantizer",
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub quantizer: Option<u32>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ingest {
    #[serde(rename = "socket")]
    pub socket: String,
    #[serde(rename = "websocketPort")]
    pub websocket_port: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    #[serde(rename = "socket")]
    pub socket: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Listen {
    #[serde(rename = "loopbackPort")]
    pub loopback_port: u32,
    #[serde(
        rename = "remotePort",
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub remote_port: Option<u32>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stats {
    #[serde(rename = "sources")]
    pub sources: Sequence,
    #[serde(rename = "viewers")]
    pub viewers: Sequence,
    #[serde(rename = "connections")]
    pub connections: Sequence,
    #[serde(rename = "cpuMs")]
    pub cpu_ms: Sequence,
    #[serde(rename = "rssBytes")]
    pub rss_bytes: Sequence,
    #[serde(rename = "bytesOut")]
    pub bytes_out: Sequence,
    #[serde(rename = "priorityLagMs")]
    pub priority_lag_ms: Sequence,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Part {
    #[serde(rename = "path")]
    pub path: String,
    #[serde(rename = "index")]
    pub index: u32,
    #[serde(rename = "bytes")]
    pub bytes: Sequence,
    #[serde(rename = "durationMs")]
    pub duration_ms: Sequence,
    #[serde(rename = "gaps")]
    pub gaps: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ToMedia {
    #[serde(rename = "init")]
    Init {
        #[serde(rename = "protocol")]
        protocol: Protocol,
        #[serde(rename = "version")]
        version: String,
        #[serde(rename = "runtimeDir")]
        runtime_dir: String,
        #[serde(rename = "dataDir")]
        data_dir: String,
        #[serde(rename = "settings")]
        settings: Settings,
    },
    #[serde(rename = "ping")]
    Ping {
        #[serde(rename = "id")]
        id: Id,
    },
    #[serde(rename = "shutdown")]
    Shutdown {
        #[serde(rename = "graceMs")]
        grace_ms: u32,
    },
    #[serde(rename = "listen")]
    Listen {
        #[serde(rename = "loopback")]
        loopback: Loopback,
        #[serde(
            rename = "remote",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        remote: Option<Remote>,
    },
    #[serde(rename = "source.open")]
    SourceOpen {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "handle")]
        handle: u32,
        #[serde(
            rename = "threadId",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        thread_id: Option<Id>,
        #[serde(
            rename = "tabId",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        tab_id: Option<Id>,
        #[serde(
            rename = "sessionId",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        session_id: Option<Id>,
        #[serde(
            rename = "deviceId",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        device_id: Option<Id>,
        #[serde(rename = "epoch")]
        epoch: u32,
        #[serde(rename = "origin")]
        origin: Origin,
    },
    #[serde(rename = "source.page")]
    SourcePage {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "width")]
        width: u32,
        #[serde(rename = "height")]
        height: u32,
        #[serde(rename = "scale")]
        scale: Nonnegative,
    },
    #[serde(rename = "source.codecs")]
    SourceCodecs {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "codecs")]
        codecs: Vec<String>,
    },
    #[serde(rename = "source.picture")]
    SourcePicture {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "ageMs")]
        age_ms: u32,
        #[serde(rename = "epoch")]
        epoch: u32,
    },
    #[serde(rename = "source.epoch")]
    SourceEpoch {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "seq")]
        seq: Sequence,
        #[serde(rename = "epoch")]
        epoch: u32,
        /// The previous epoch was private, so reads within 100 ms of applying this one keep it.
        #[serde(rename = "followsPrivate")]
        follows_private: bool,
    },
    #[serde(rename = "record.epochs")]
    RecordEpochs {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "seq")]
        seq: Sequence,
        #[serde(rename = "decided")]
        decided: u32,
        #[serde(rename = "clear")]
        clear: Vec<EpochRange>,
        #[serde(rename = "discard")]
        discard: Vec<EpochRange>,
    },
    #[serde(rename = "source.close")]
    SourceClose {
        #[serde(rename = "source")]
        source: Id,
    },
    #[serde(rename = "media.ticket")]
    MediaTicket {
        #[serde(rename = "connection")]
        connection: Id,
        #[serde(rename = "owner")]
        owner: Owner,
        #[serde(rename = "issued")]
        issued: Sequence,
        #[serde(rename = "expiresAt")]
        expires_at: Sequence,
    },
    #[serde(rename = "viewer.open")]
    ViewerOpen {
        #[serde(rename = "viewer")]
        viewer: Id,
        #[serde(rename = "connection")]
        connection: Id,
        #[serde(rename = "owner")]
        owner: Owner,
        #[serde(rename = "issued")]
        issued: Sequence,
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "codecs")]
        codecs: Vec<String>,
        #[serde(rename = "viewport")]
        viewport: Viewport,
        #[serde(rename = "local")]
        local: bool,
        #[serde(rename = "audio")]
        audio: bool,
    },
    #[serde(rename = "viewer.configure")]
    ViewerConfigure {
        #[serde(rename = "viewer")]
        viewer: Id,
        #[serde(rename = "viewport")]
        viewport: Viewport,
        #[serde(rename = "audio")]
        audio: bool,
    },
    #[serde(rename = "viewer.close")]
    ViewerClose {
        #[serde(rename = "viewer")]
        viewer: Id,
    },
    #[serde(rename = "relay.dial")]
    RelayDial {
        #[serde(rename = "stream")]
        stream: Id,
        #[serde(rename = "url")]
        url: String,
    },
    #[serde(rename = "relay.out")]
    RelayOut {
        #[serde(rename = "stream")]
        stream: Id,
    },
    #[serde(rename = "relay.pull")]
    RelayPull {
        #[serde(rename = "stream")]
        stream: Id,
    },
    #[serde(rename = "relay.keys")]
    RelayKeys {
        #[serde(rename = "stream")]
        stream: Id,
        #[serde(rename = "connection")]
        connection: Id,
        #[serde(rename = "owner")]
        owner: Owner,
        #[serde(rename = "issued")]
        issued: Sequence,
    },
    #[serde(rename = "relay.close")]
    RelayClose {
        #[serde(rename = "id")]
        id: Id,
        #[serde(rename = "stream")]
        stream: Id,
        #[serde(rename = "reason")]
        reason: String,
    },
    #[serde(rename = "connection.close")]
    ConnectionClose {
        #[serde(rename = "id")]
        id: Id,
        #[serde(rename = "connection")]
        connection: Id,
        #[serde(rename = "reason")]
        reason: String,
    },
    #[serde(rename = "revoke")]
    Revoke {
        #[serde(rename = "id")]
        id: Id,
        #[serde(rename = "issued")]
        issued: Sequence,
        #[serde(rename = "device")]
        device: Id,
        #[serde(
            rename = "admission",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        admission: Option<Admission>,
    },
    #[serde(rename = "record.start")]
    RecordStart {
        #[serde(rename = "recording")]
        recording: Id,
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "directory")]
        directory: String,
        #[serde(rename = "maxBytes")]
        max_bytes: Sequence,
        #[serde(rename = "pointerTrack")]
        pointer_track: bool,
    },
    #[serde(rename = "record.cut")]
    RecordCut {
        #[serde(rename = "recording")]
        recording: Id,
        #[serde(rename = "reason")]
        reason: CutReason,
    },
    #[serde(rename = "record.meta")]
    RecordMeta {
        #[serde(rename = "recording")]
        recording: Id,
        #[serde(rename = "epoch")]
        epoch: u32,
        #[serde(rename = "data")]
        data: serde_json::Value,
    },
    #[serde(rename = "record.stop")]
    RecordStop {
        #[serde(rename = "recording")]
        recording: Id,
    },
    #[serde(rename = "still.take")]
    StillTake {
        #[serde(rename = "request")]
        request: Id,
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "maxWidth")]
        max_width: u32,
        #[serde(rename = "maxHeight")]
        max_height: u32,
        #[serde(rename = "maxPixels")]
        max_pixels: u32,
        #[serde(rename = "quality")]
        quality: u32,
        #[serde(rename = "deadlineMs")]
        deadline_ms: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum FromMedia {
    #[serde(rename = "ready")]
    Ready {
        #[serde(rename = "protocol")]
        protocol: Protocol,
        #[serde(rename = "version")]
        version: String,
        #[serde(rename = "pid")]
        pid: u32,
        #[serde(rename = "capabilities")]
        capabilities: Vec<Capability>,
        #[serde(rename = "ingest")]
        ingest: Ingest,
        #[serde(rename = "control")]
        control: Control,
        #[serde(rename = "listen")]
        listen: Listen,
    },
    /// The whole list again, after a trial finished late or a backend changed.
    #[serde(rename = "capabilities.changed")]
    CapabilitiesChanged {
        #[serde(rename = "capabilities")]
        capabilities: Vec<Capability>,
    },
    #[serde(rename = "pong")]
    Pong {
        #[serde(rename = "id")]
        id: Id,
        #[serde(rename = "stats")]
        stats: Stats,
    },
    #[serde(rename = "revoked")]
    Revoked {
        #[serde(rename = "id")]
        id: Id,
    },
    #[serde(rename = "closed")]
    Closed {
        #[serde(rename = "id")]
        id: Id,
    },
    #[serde(rename = "epoch.applied")]
    EpochApplied {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "seq")]
        seq: Sequence,
        #[serde(rename = "epoch")]
        epoch: u32,
    },
    #[serde(rename = "epochs.applied")]
    EpochsApplied {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "seq")]
        seq: Sequence,
        #[serde(rename = "written")]
        written: Sequence,
        #[serde(rename = "dropped")]
        dropped: Sequence,
    },
    #[serde(rename = "source.status")]
    SourceStatus {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "status")]
        status: Status,
        #[serde(
            rename = "reason",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        reason: Option<String>,
        #[serde(
            rename = "attempts",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        attempts: Option<u32>,
        #[serde(
            rename = "acceleration",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        acceleration: Option<Acceleration>,
    },
    #[serde(rename = "source.want")]
    SourceWant {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "encodes")]
        encodes: Vec<EncodeSpec>,
    },
    #[serde(rename = "source.keyframe")]
    SourceKeyframe {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "encode")]
        encode: u32,
        #[serde(rename = "reason")]
        reason: KeyReason,
    },
    #[serde(rename = "source.audio")]
    SourceAudio {
        #[serde(rename = "source")]
        source: Id,
        #[serde(rename = "on")]
        on: bool,
    },
    #[serde(rename = "viewer.playing")]
    ViewerPlaying {
        #[serde(rename = "viewer")]
        viewer: Id,
        #[serde(rename = "playing")]
        playing: bool,
    },
    #[serde(rename = "viewer.stats")]
    ViewerStats {
        #[serde(rename = "viewer")]
        viewer: Id,
        #[serde(rename = "rate")]
        rate: u32,
        #[serde(rename = "fps")]
        fps: Nonnegative,
        #[serde(rename = "dropped")]
        dropped: Sequence,
        #[serde(rename = "rttMs")]
        rtt_ms: Nonnegative,
    },
    #[serde(rename = "connection.open")]
    ConnectionOpen {
        #[serde(rename = "connection")]
        connection: Id,
        #[serde(rename = "kind")]
        kind: ConnectionKind,
        #[serde(rename = "owner")]
        owner: Owner,
    },
    #[serde(rename = "connection.closed")]
    ConnectionClosed {
        #[serde(rename = "connection")]
        connection: Id,
        #[serde(rename = "reason")]
        reason: String,
    },
    #[serde(rename = "grant.refused")]
    GrantRefused {
        #[serde(rename = "kind")]
        kind: String,
        #[serde(rename = "id")]
        id: Id,
        #[serde(rename = "reason")]
        reason: Refusal,
    },
    #[serde(rename = "relay.dialed")]
    RelayDialed {
        #[serde(rename = "stream")]
        stream: Id,
    },
    #[serde(rename = "relay.failed")]
    RelayFailed {
        #[serde(rename = "stream")]
        stream: Id,
        #[serde(rename = "reason")]
        reason: String,
    },
    #[serde(rename = "relay.in")]
    RelayIn {
        #[serde(rename = "stream")]
        stream: Id,
    },
    #[serde(rename = "record.part")]
    RecordPart {
        #[serde(rename = "recording")]
        recording: Id,
        #[serde(rename = "path")]
        path: String,
        #[serde(rename = "index")]
        index: u32,
        #[serde(rename = "bytes")]
        bytes: Sequence,
        #[serde(rename = "durationMs")]
        duration_ms: Sequence,
        #[serde(rename = "gaps")]
        gaps: u32,
    },
    #[serde(rename = "record.done")]
    RecordDone {
        #[serde(rename = "recording")]
        recording: Id,
        #[serde(rename = "parts")]
        parts: Vec<Part>,
    },
    #[serde(rename = "record.failed")]
    RecordFailed {
        #[serde(rename = "recording")]
        recording: Id,
        #[serde(rename = "reason")]
        reason: String,
    },
    #[serde(rename = "still.done")]
    StillDone {
        #[serde(rename = "request")]
        request: Id,
        #[serde(rename = "width")]
        width: u32,
        #[serde(rename = "height")]
        height: u32,
    },
    #[serde(rename = "still.failed")]
    StillFailed {
        #[serde(rename = "request")]
        request: Id,
        #[serde(rename = "reason")]
        reason: String,
    },
    #[serde(rename = "log")]
    Log {
        #[serde(rename = "level")]
        level: Level,
        #[serde(rename = "message")]
        message: String,
        #[serde(rename = "fields")]
        fields: serde_json::Value,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Lane {
    Normal,
    Priority,
}
pub fn lane(kind: &str) -> Lane {
    match kind {
        "revoke" | "connection.close" | "relay.close" | "source.epoch" | "record.epochs"
        | "shutdown" | "revoked" | "closed" | "epoch.applied" | "epochs.applied" => Lane::Priority,
        _ => Lane::Normal,
    }
}
#[derive(Debug, PartialEq)]
pub struct InvalidControl;
pub struct ControlFrame<M> {
    pub message: M,
    pub payload: zeroize::Zeroizing<Vec<u8>>,
}
pub trait Message: Serialize + for<'de> Deserialize<'de> {}
impl Message for ToMedia {}
impl Message for FromMedia {}
fn validate<M: Message>(message: &M, payload: &[u8], expected: Lane) -> Result<(), InvalidControl> {
    let value = serde_json::to_value(message).map_err(|_| InvalidControl)?;
    let kind = value["type"].as_str().ok_or(InvalidControl)?;
    if lane(kind) != expected || (expected == Lane::Priority && payload.len() > 256) {
        return Err(InvalidControl);
    }
    if value.get("protocol").is_some_and(|p| p.as_u64() != Some(1))
        || value
            .get("loopback")
            .is_some_and(|p| p.as_bool() != Some(true))
    {
        return Err(InvalidControl);
    }
    let length = match kind {
        "init" | "source.open" | "media.ticket" => 32,
        "relay.keys" => 120,
        "listen" => {
            value["remote"]["certificateBytes"].as_u64().unwrap_or(0)
                + value["remote"]["keyBytes"].as_u64().unwrap_or(0)
        }
        "source.picture" | "relay.out" | "relay.in" | "still.done" => return Ok(()),
        _ => 0,
    };
    if payload.len() as u64 != length {
        return Err(InvalidControl);
    }
    Ok(())
}
impl<M: Message> ControlFrame<M> {
    /// Header and payload stay separate; the caller writes the payload without copying keys.
    pub fn header(&self, lane: Lane) -> Result<Vec<u8>, InvalidControl> {
        validate(&self.message, &self.payload, lane)?;
        let json = serde_json::to_vec(&self.message).map_err(|_| InvalidControl)?;
        let length = 4 + json.len() + self.payload.len();
        let limit = match lane {
            Lane::Normal => 8 * 1024 * 1024,
            Lane::Priority => 64 * 1024,
        };
        if length > limit {
            return Err(InvalidControl);
        }
        let mut b = Vec::with_capacity(8 + json.len());
        b.extend_from_slice(&(length as u32).to_be_bytes());
        b.extend_from_slice(&(json.len() as u32).to_be_bytes());
        b.extend(json);
        Ok(b)
    }
    pub fn decode(b: &[u8], lane: Lane) -> Result<Self, InvalidControl> {
        if b.len() < 8 {
            return Err(InvalidControl);
        }
        let length = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize;
        let j = u32::from_be_bytes([b[4], b[5], b[6], b[7]]) as usize;
        let limit = match lane {
            Lane::Normal => 8 * 1024 * 1024,
            Lane::Priority => 64 * 1024,
        };
        if length < 4 || length > limit || length + 4 != b.len() || j > length - 4 {
            return Err(InvalidControl);
        }
        let message = serde_json::from_slice(&b[8..8 + j]).map_err(|_| InvalidControl)?;
        validate(&message, &b[8 + j..], lane)?;
        Ok(Self {
            message,
            payload: zeroize::Zeroizing::new(b[8 + j..].to_vec()),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Sequence(u64);
impl Sequence {
    pub fn new(value: u64) -> Result<Self, &'static str> {
        if value > 9_007_199_254_740_991 {
            return Err("sequence exceeds safe integer");
        }
        Ok(Self(value))
    }
    pub fn get(&self) -> u64 {
        self.0
    }
}
impl<'de> Deserialize<'de> for Sequence {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(u64::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct EpochRange([u32; 2]);
impl EpochRange {
    pub fn new(value: [u32; 2]) -> Result<Self, &'static str> {
        if value[0] > value[1] {
            return Err("reversed epoch range");
        }
        Ok(Self(value))
    }
    pub fn get(&self) -> [u32; 2] {
        self.0
    }
}
impl<'de> Deserialize<'de> for EpochRange {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(<[u32; 2]>::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Nonnegative(f64);
impl Nonnegative {
    pub fn new(value: f64) -> Result<Self, &'static str> {
        if !value.is_finite() || value < 0.0 {
            return Err("invalid nonnegative number");
        }
        Ok(Self(value))
    }
    pub fn get(&self) -> f64 {
        self.0
    }
}
impl<'de> Deserialize<'de> for Nonnegative {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(f64::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Protocol(u8);
impl Protocol {
    pub fn new(value: u8) -> Result<Self, &'static str> {
        if value != 1 {
            return Err("invalid protocol");
        }
        Ok(Self(value))
    }
    pub fn get(&self) -> u8 {
        self.0
    }
}
impl<'de> Deserialize<'de> for Protocol {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(u8::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Loopback(bool);
impl Loopback {
    pub fn new(value: bool) -> Result<Self, &'static str> {
        if !value {
            return Err("loopback must be true");
        }
        Ok(Self(value))
    }
    pub fn get(&self) -> bool {
        self.0
    }
}
impl<'de> Deserialize<'de> for Loopback {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(bool::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
// Missing fields use serde's default; a present field must deserialize as T, never null.
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
