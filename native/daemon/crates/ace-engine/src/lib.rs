// SPDX-License-Identifier: Apache-2.0
//! The daemon's engine (ADR 0223 §2, E5). E0 declares the modules; E5.1 ports
//! the facade, executor, ports, registry, workers and limits first, then
//! E5.2 to E5.10 port their modules in order. The engine is async Rust on a
//! local executor on the JS thread, sharing the store's transaction stack.

pub mod access;
pub mod actor;
pub mod approvals;
pub mod commands;
pub mod cursor_reconcile;
pub mod delegation;
pub mod delivery;
pub mod executor;
pub mod frames;
pub mod hosts;
pub mod inputs;
pub mod intents;
pub mod limits;
pub mod liveness;
pub mod meters;
pub mod models;
pub mod moves;
pub mod ports;
pub mod queue;
pub mod records;
pub mod recovery;
pub mod registry;
pub mod release;
pub mod repository;
pub mod restart;
pub mod sessions;
pub mod settle;
pub mod snapshot;
pub mod steering;
pub mod transitions;
pub mod workers;
