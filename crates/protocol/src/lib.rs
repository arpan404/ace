use ace_core::{Command, ProviderCapability};
use serde::{Deserialize, Serialize};

pub mod checkpoint;
pub mod git;
pub mod github;
pub mod project;
pub mod ws;

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientEnvelope {
    pub version: u16,
    pub request_id: String,
    pub payload: ClientPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientPayload {
    Command(Box<Command>),
    Subscribe {
        from_sequence_exclusive: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerEnvelope {
    pub version: u16,
    pub sequence: Option<u64>,
    pub payload: ServerPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServerPayload {
    Ack { request_id: String },
    Capabilities { providers: Vec<ProviderCapability> },
    ProjectionDelta(ProjectionDelta),
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProjectionDelta {
    ServerStatusChanged { message: String },
}
