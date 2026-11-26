// SPDX-License-Identifier: Apache-2.0
//! Model discovery for `ace-daemon-bin` (ADR 0226, slice 4): `@ace/models` and the
//! adapters' catalog readers as sans-IO parsers over the provider's reply bytes.
//!
//! Provider processes and HTTP servers are ports injected by the caller. This crate
//! only turns bytes into catalog rows, maps efforts onto ace's scale, searches and
//! freezes them.

pub mod acp;
pub mod claude;
pub mod codex;
pub mod cursor;
pub mod display_name;
pub mod effort;
pub mod free;
pub mod freeze;
pub mod instance;
pub mod metadata;
pub mod native;
pub mod opencode;
pub mod pi;
pub mod raw;
pub mod row;
pub mod search;
pub mod source;
