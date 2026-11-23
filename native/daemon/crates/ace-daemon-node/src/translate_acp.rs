// SPDX-License-Identifier: Apache-2.0
//! The ACP translator binding (E1): values cross, behaviour stays in the crate.

use ace_adapter_acp::{
    AcpError,
    translate::{quirks::QuirksKind, state::TranslatorIdentity, translator::AcpTranslator},
};
use napi_derive::napi;
use std::panic::{AssertUnwindSafe, catch_unwind};

/// A native ACP translator handle.
#[napi]
pub struct NativeAcpTranslator {
    inner: AcpTranslator,
}

fn unwind_error() -> napi::Error {
    napi::Error::from_reason("acp translator panicked".to_owned())
}

fn map_error(error: AcpError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

#[napi]
impl NativeAcpTranslator {
    #[napi(constructor, catch_unwind)]
    pub fn new(
        thread_id: String,
        root_key: String,
        generation: String,
        cursor: f64,
        quirks: String,
    ) -> napi::Result<Self> {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            if generation.is_empty() || !(0.0..9_007_199_254_740_991.0).contains(&cursor) {
                return Err(map_error(AcpError::InvalidIdentity));
            }
            let identity = TranslatorIdentity {
                generation,
                cursor: cursor as i64,
            };
            Ok(Self {
                inner: AcpTranslator::new(
                    root_key,
                    QuirksKind::from_name(&quirks),
                    thread_id,
                    identity,
                ),
            })
        }));
        match outcome {
            Ok(result) => result,
            Err(_) => Err(unwind_error()),
        }
    }

    #[napi(catch_unwind)]
    pub fn translate(&mut self, frame_json: String, now: f64) -> napi::Result<String> {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let frame: serde_json::Value = serde_json::from_str(&frame_json)
                .map_err(|error| map_error(AcpError::InvalidFrame(error.to_string())))?;
            let facts = self.inner.translate(&frame, now as i64);
            serde_json::to_string(&facts)
                .map_err(|error| map_error(AcpError::Serialize(error.to_string())))
        }));
        match outcome {
            Ok(result) => result,
            Err(_) => Err(unwind_error()),
        }
    }

    #[napi(catch_unwind)]
    pub fn tick(&mut self, now: f64) -> napi::Result<String> {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let facts = self.inner.tick(now as i64);
            serde_json::to_string(&facts)
                .map_err(|error| map_error(AcpError::Serialize(error.to_string())))
        }));
        match outcome {
            Ok(result) => result,
            Err(_) => Err(unwind_error()),
        }
    }

    #[napi(catch_unwind)]
    pub fn take_diagnostics(&mut self) -> napi::Result<String> {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let diagnostics = self.inner.take_diagnostics();
            serde_json::to_string(&diagnostics)
                .map_err(|error| map_error(AcpError::Serialize(error.to_string())))
        }));
        match outcome {
            Ok(result) => result,
            Err(_) => Err(unwind_error()),
        }
    }

    #[napi(catch_unwind)]
    pub fn next_deadline(&self) -> napi::Result<Option<f64>> {
        let outcome = catch_unwind(AssertUnwindSafe(|| None));
        match outcome {
            Ok(result) => Ok(result),
            Err(_) => Err(unwind_error()),
        }
    }
}
