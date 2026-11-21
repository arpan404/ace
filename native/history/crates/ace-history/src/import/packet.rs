// SPDX-License-Identifier: Apache-2.0

//! What an import yields (`Packet` in contracts.ts).

use serde_json::{Value, json};

use crate::session::Accuracy;

#[derive(Debug, Clone, PartialEq)]
pub enum Packet {
    Thread(Value),
    Agent(Value),
    Item(Value),
    BlobStart { id: String, bytes: u64 },
    BlobChunk { id: String, bytes: Vec<u8> },
    BlobEnd { id: String },
    Barrier,
    End { count: i64, accuracy: Accuracy },
}

impl Packet {
    /// The packet's JSON, with a chunk's bytes as the n-th body of its message.
    pub fn to_json(&self, bodies: &mut Vec<Vec<u8>>) -> Value {
        match self {
            Packet::Thread(thread) => json!({ "type": "thread", "thread": thread }),
            Packet::Agent(agent) => json!({ "type": "agent", "agent": agent }),
            Packet::Item(item) => json!({ "type": "item", "item": item }),
            Packet::BlobStart { id, bytes } => {
                json!({ "type": "blob.start", "id": id, "bytes": bytes })
            }
            Packet::BlobChunk { id, bytes } => {
                bodies.push(bytes.clone());
                json!({ "type": "blob.chunk", "id": id, "bytes": history_wire::body_ref(bodies.len() - 1) })
            }
            Packet::BlobEnd { id } => json!({ "type": "blob.end", "id": id }),
            Packet::Barrier => json!({ "type": "barrier" }),
            Packet::End { count, accuracy } => json!({
                "type": "end",
                "messageCount": count,
                "countAccuracy": match accuracy { Accuracy::Exact => "exact", Accuracy::Sampled => "sampled" },
            }),
        }
    }
}

/// Where an import's packets go; an error stops the import.
pub type Emit<'a> = &'a mut dyn FnMut(Packet) -> crate::error::Result<()>;

/// A byte stream as blob packets of at most 64 KiB.
pub fn blob(id: &str, bytes: &[u8], emit: Emit<'_>) -> crate::error::Result<()> {
    emit(Packet::BlobStart {
        id: id.to_owned(),
        bytes: bytes.len() as u64,
    })?;
    for chunk in bytes.chunks(64 * 1024) {
        emit(Packet::BlobChunk {
            id: id.to_owned(),
            bytes: chunk.to_vec(),
        })?;
    }
    emit(Packet::BlobEnd { id: id.to_owned() })
}
