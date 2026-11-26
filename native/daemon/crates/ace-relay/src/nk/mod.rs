// SPDX-License-Identifier: Apache-2.0
//! The NK path (ADR 0155): what a first message may cost before confirmation, the reads it may
//! ask for early, and the host admission that spends its ticket or grant.

pub mod admission;
pub mod early_reads;
pub mod hello;
pub mod host;

#[cfg(test)]
pub(crate) mod tests_support;
