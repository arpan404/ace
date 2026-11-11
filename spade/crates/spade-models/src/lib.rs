//! Spade's model access. The person's endpoints are set at run time ([`Models::set_endpoints`]);
//! the shipped JSON catalogue ([`Catalog`]) holds presets and known model facts. Any endpoint that
//! speaks OpenAI Chat Completions, OpenAI Responses or Anthropic Messages works. Callers name a
//! model as `endpoint/model`; any model id works, with facts from what the person saved, else the
//! presets, else defaults. The SDK stays inside this crate.

pub mod base_url;
pub mod catalog;
mod client;
pub mod config;
mod error;
mod format;
pub mod listing;
mod prompt;
mod thoughts;
mod typed;

pub use catalog::{
    Capability, Catalog, CatalogError, DEFAULT_CONTEXT, Endpoint, Model, Price, Resolved, Role,
};
pub use client::{KEYLESS, Models};
pub use config::ModelsConfig;
pub use error::ModelError;
pub use format::Format;
pub use listing::{ListBounds, Listed};
pub use prompt::{
    Delta, Generated, Image, Message, Prompt, Reply, Thought, ToolCall, ToolSpec, Usage,
};
pub use spade_keys::{KeyRequest, Keys};
