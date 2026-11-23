// SPDX-License-Identifier: Apache-2.0
//! The ported command groups (ADR 0221 step 4): each module names the command ids it answers
//! itself and dispatches them. Anything else falls through to the bundle.

pub mod machine;
