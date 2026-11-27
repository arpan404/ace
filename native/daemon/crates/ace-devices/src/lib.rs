// SPDX-License-Identifier: Apache-2.0
//! The device platform behind `@ace/devices` (ADR 0225, docs/devices/porting-guide.md D3.1),
//! beside device discovery and pushed inventory (D2). Behaviour lives here; the binding only
//! translates values, and the TypeScript shell still runs every SDK command through
//! `@ace/provider-kit`'s supervisor with today's limits and ordering.

pub mod catalog;
pub mod error;
pub mod inventory;
pub mod platform;
pub mod service;
pub mod tools;
