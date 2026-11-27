// SPDX-License-Identifier: Apache-2.0
//! The adapter interface: the Rust form of `@ace/engine-api` (ADR 0223 §2).
//! Behaviour lives in the crates that implement these traits; the binding
//! (`ace-daemon-node`) only translates values and errors.

pub mod adapter;
pub mod bridge;
pub mod error;
pub mod frame;
pub mod payload;
pub mod session;
pub mod translator;
pub mod util;

pub use adapter::{Adapter, TranslatorInit};
pub use error::AdapterApiError;
pub use frame::{BillingMode, Frame, FrameDirection, UsageAccount};
pub use session::{
    CloseReason, Delivery, InterruptTarget, Session, SessionContext, SteerFence,
    assert_steer_target,
};
pub use translator::Translator;
