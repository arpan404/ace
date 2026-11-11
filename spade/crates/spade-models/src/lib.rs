//! Spade's model access. Endpoints and their models are listed in a JSON catalogue loaded at
//! startup ([`Catalog`]). Any endpoint that speaks OpenAI Chat Completions, OpenAI Responses or
//! Anthropic Messages works. Callers name a model as `endpoint/model` or ask for a [`Role`]. The
//! SDK stays inside this crate.

pub mod catalog;
mod client;
pub mod config;
mod error;
mod format;
mod prompt;
mod typed;

pub use catalog::{Capability, Catalog, CatalogError, Endpoint, Model, Price, Resolved, Role};
pub use client::{KEYLESS, Models};
pub use config::ModelsConfig;
pub use error::ModelError;
pub use format::Format;
pub use prompt::{Delta, Generated, Message, Prompt, Reply, ToolCall, ToolSpec, Usage};
pub use spade_keys::{KeyRequest, Keys};
