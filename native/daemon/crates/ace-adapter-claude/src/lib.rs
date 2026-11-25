// SPDX-License-Identifier: Apache-2.0
//! The claude adapter (ADR 0223 section 2). E0 declares the modules; E1 ports the
//! translator closure into translate. The session stays TypeScript behind the
//! bridge (ADR 0223, decided by the orchestrator): there is no E3 item for Claude.

pub mod input;
pub mod translate;
