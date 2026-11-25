// SPDX-License-Identifier: Apache-2.0
//! Why a control request could not be built: the controls are closed for writing.

use thiserror::Error;

/// [`crate::control::Controls::request`]'s only refusal: the controls closed (`drain` ran).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ControlError {
    #[error("the stream-json controls are closed")]
    Closed,
}
