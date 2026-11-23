// SPDX-License-Identifier: Apache-2.0
//! The strict Git output parsers beside the reads that use them (G3a owns
//! `status`, `repository` and `numstat`; G3b owns `diff` and `index`; G3c
//! owns `history`). The (b) cases of `malformed-output` move here with their
//! modules. G0 stub.

pub mod diff;
pub mod history;
pub mod index;
pub mod numstat;
pub mod repository;
pub mod status;
