// SPDX-License-Identifier: Apache-2.0
//! The schemas each module uses, mirrored field for field from the Zod schemas (ADR 0224 §3
//! and porting-guide rule 6). A failed decode is the error the TypeScript raises
//! (`invalid_data`, never a raw `ZodError`); protocol output types come from `ace-protocol`.
//! F0 declares the module; each work item fills its own schema file.

pub mod bitbucket;
pub mod common;
pub mod github;
pub mod gitlab;
pub mod origin;
pub mod tea;
