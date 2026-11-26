// SPDX-License-Identifier: Apache-2.0
//! Settings: the versioned document, value guards, role slots and atomic batches
//! (`packages/settings/src/{document,validation,roles,batch}.ts`).
//!
//! The document is schema-independent here: known values are the caller's policy, and
//! unknown keys and fields survive every edit. File watching and the daemon service are
//! ports the composing crate injects.

pub mod batch;
pub mod document;
pub mod edit;
pub mod file;
pub mod jsonc;
pub mod layers;
pub mod roles;
pub mod schema;
pub mod service;
pub mod validation;
pub mod workspace;
