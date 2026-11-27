// SPDX-License-Identifier: Apache-2.0
//! The store writer's own pieces (docs/store/porting-guide.md, phase 5). Each module ports one
//! TypeScript collaborator behind `ACE_STORE_WRITER`; TypeScript stays the caller until the
//! engine (ADR 0223 E5).

pub mod events;
pub mod live;
pub mod sequences;
pub mod thread_columns;
pub mod transaction;
