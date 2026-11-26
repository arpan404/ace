// SPDX-License-Identifier: Apache-2.0
//! The model catalog service (`packages/models/src/catalog.ts` and its pure pieces).
//!
//! Classification and defaults ([`classify`]), preference views
//! ([`configured_models`]), model resolution ([`resolve_model`]) and the cache
//! ([`cache`]) live here as functions over rows. Discovery and persistence are ports
//! the daemon injects; nothing here spawns a process, reads a file or reads the clock.

pub mod cache;
pub mod classification;
