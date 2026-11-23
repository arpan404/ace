// SPDX-License-Identifier: Apache-2.0
//! Ported command groups, one module per group (ADR 0221 step 4). Each exposes `IDS` and a
//! dispatch fn; anything else falls through to the bundle.

pub mod agent_tools;
pub mod machine;
pub mod providers;
pub mod work;
