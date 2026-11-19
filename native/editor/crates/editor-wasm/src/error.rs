// SPDX-License-Identifier: Apache-2.0

//! The failure a rejected call carries across the boundary.

use wasm_bindgen::JsValue;

/// The one error code this crate produces, shared with the daemon and the clients.
pub(crate) const INVALID_ARGUMENT: &str = "INVALID_ARGUMENT";

/// A rejected call: a shared code plus a message for the person reading the console.
///
/// Conversions return this instead of a [`JsValue`], so the pure parts stay testable natively;
/// the public methods turn it into a JavaScript `Error` with a `code` property.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl Failure {
    /// A failure with an explicit code.
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Failure {
        Failure {
            code,
            message: message.into(),
        }
    }

    /// A malformed argument, the only rejection a caller can cause directly.
    pub(crate) fn invalid(message: impl Into<String>) -> Failure {
        Failure::new(INVALID_ARGUMENT, message)
    }

    /// The core's own error, with its shared code.
    pub(crate) fn from_core(error: editor_core::Error) -> Failure {
        Failure::new(error.code(), error.to_string())
    }
}

impl From<Failure> for JsValue {
    fn from(failure: Failure) -> JsValue {
        let error = js_sys::Error::new(&failure.message);
        error.set_name("EditorError");
        let _ = js_sys::Reflect::set(
            &error,
            &JsValue::from_str("code"),
            &JsValue::from_str(failure.code),
        );
        error.into()
    }
}
