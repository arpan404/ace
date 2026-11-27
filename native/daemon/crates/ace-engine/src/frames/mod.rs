// SPDX-License-Identifier: Apache-2.0
//! The pure frame helpers the repository and the actor call (E5.2): byte measures, the envelope
//! check, coalescing, raw capping, attachment echoes and correlations, and the streaming fold.
//! Nothing here touches the store, a port or an actor: each function takes its inputs and its
//! lookups as arguments, so it is tested directly.

pub mod attachment_payload;
pub mod attachments;
pub mod bytes;
pub mod coalesce;
pub mod correlations;
pub mod envelope;
pub mod live;
pub mod raw;
pub mod stream;

pub use attachment_payload::attachment_payload;
pub use attachments::{attachment_echo, image_hash, path_hash};
pub use bytes::{json_string_bytes, streamed_facts_bytes, utf8_len};
pub use coalesce::coalesce_facts;
pub use correlations::Correlations;
pub use envelope::{AccountField, Envelope, Field, PayloadField, envelope_error};
pub use live::{LiveSnapshot, LiveStore, UnportedLive};
pub use raw::{cap_fact, read_raw_blob};
pub use stream::{Prepared, StreamSnapshot, stream_facts};
