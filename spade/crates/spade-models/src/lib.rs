//! Spade's model access. The person's endpoints are set at run time ([`Models::set_endpoints`]);
//! the shipped JSON catalogue ([`Catalog`]) holds presets and known model facts. Any endpoint that
//! speaks OpenAI Chat Completions, OpenAI Responses or Anthropic Messages works. Callers name a
//! model as `endpoint/model`; any model id works, with facts from what the person saved, else the
//! presets, else defaults. The SDK stays inside this crate.

pub mod base_url;
mod bound;
pub mod catalog;
pub mod chatgpt;
mod client;
mod closed_calls;
pub mod config;
mod effort;
mod error;
mod failure;
mod format;
pub mod known_good;
pub mod listing;
mod media;
mod probes;
mod prompt;
mod scrub;
mod signed;
mod speech;
mod thoughts;
mod typed;
mod waits;
mod web_search;

pub use catalog::{
    Capability, Catalog, CatalogError, DEFAULT_CONTEXT, Endpoint, LongContext, Model, Price,
    Resolved, Role,
};
pub use chatgpt::SignIn;
pub use client::{GATEWAY_HEADER, KEYLESS, Models};
pub use config::ModelsConfig;
pub use effort::Effort;
pub use error::{ModelError, Unserved};
pub use format::Format;
pub use known_good::KnownGood;
pub use listing::{ListBounds, Listed};
pub use media::{MOST_AUDIO_BYTES, MOST_MEDIA_ANSWER};
pub use probes::{PROBE_TOOL, PROBE_WAIT, Probe, ProbeResults};
pub use prompt::{
    Delta, Generated, Image, Message, Prompt, Reply, Thought, ToolCall, ToolSpec, Usage,
};
pub use signed::{BearerFuture, Bearers, Credential, DispatchFuture, DispatchGuard};
pub use spade_keys::{KeyRequest, Keys};
pub use speech::{MOST_SPEECH_BYTES, MOST_SPEECH_CHARS, Speech, SpeechRequest};
pub use waits::StreamWaits;
pub use web_search::{WebFound, WebHit};
