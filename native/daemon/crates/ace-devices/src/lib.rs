// SPDX-License-Identifier: Apache-2.0
//! The device platform behind `@ace/devices` (ADR 0225, docs/devices/porting-guide.md D3.1).
//! Behaviour lives here; `crates/ace-daemon-node/src/devices` only translates values, and the
//! TypeScript shell (`packages/devices/src/native-platform.ts`) still runs every SDK command
//! through `@ace/provider-kit`'s supervisor with today's limits and ordering.

pub mod platform;
