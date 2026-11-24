// SPDX-License-Identifier: Apache-2.0
//! The binding for phase 5 (docs/store/porting-guide.md). One method per task; 5.1 owns
//! `fold_thread`. It does not touch the connection.

use ace_projection::{FoldEvent, update_thread};
use napi::Env;
use napi_derive::napi;

use crate::NativeDatabase;
use crate::json_bind;

#[napi]
impl NativeDatabase {
    /// The folded thread as JSON text. `payload` is the text the shell sent, or None.
    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn fold_thread(
        &self,
        env: Env,
        thread: String,
        kind: String,
        seq: f64,
        at: f64,
        payload: Option<String>,
    ) -> napi::Result<String> {
        let thread_value = json_bind::parse(&env, &thread)?;
        let mut thread_map = match thread_value {
            ace_json::Value::Object(map) => map,
            _ => {
                return Err(napi::Error::from_reason("fold: thread is not an object"));
            }
        };
        let payload_value = match payload {
            Some(text) => Some(json_bind::parse(&env, &text)?),
            None => None,
        };
        let event = FoldEvent::from_wire(&kind, payload_value.as_ref(), seq)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        update_thread(&mut thread_map, event, at)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(ace_json::to_string(&ace_json::Value::Object(thread_map)))
    }
}
