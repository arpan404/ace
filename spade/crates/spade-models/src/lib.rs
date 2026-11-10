//! Spade's model access. Models are listed in a JSON catalogue file loaded at startup
//! ([`Catalog`]); callers name them by Spade's own ids or ask for a [`Role`], and the configured
//! [`Gateway`] decides where calls go. The SDK stays inside this crate.

pub mod catalog;
mod client;
pub mod config;
mod error;
pub mod gateway;
mod prompt;
mod typed;

pub use catalog::{Catalog, CatalogError, Model, Price, Role, Route};
pub use client::Models;
pub use config::{ApiKey, ModelsConfig};
pub use error::ModelError;
pub use gateway::{Gateway, Protocol};
pub use prompt::{Delta, Message, Prompt, Reply, Speaker, Usage};
