// SPDX-License-Identifier: Apache-2.0
//! The store writer's own small pieces (docs/store/porting-guide.md, tasks 5.2 onward). Each
//! module ports one TypeScript collaborator behind `ACE_STORE_WRITER`; the loop that calls them
//! stays TypeScript until 5.3.

pub mod sequences;
