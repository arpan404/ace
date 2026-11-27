// SPDX-License-Identifier: Apache-2.0
//! The binding for `ace_store::reads::long_thread`. Phase 2: turns, steps, catch-up and in-thread search (docs/store/porting-guide.md).

use crate::{NativeDatabase, fail};
use ace_store::reads::long_thread::{thread_catch_up, thread_search, turn_steps, turns_page};
use napi_derive::napi;

fn integer(value: f64, name: &str) -> napi::Result<i64> {
    if value.fract() != 0.0 || !value.is_finite() {
        return Err(napi::Error::from_reason(format!("invalid {name}")));
    }
    let value = value as i64;
    Ok(value)
}

fn optional_integer(value: Option<f64>, name: &str) -> napi::Result<Option<i64>> {
    match value {
        None => Ok(None),
        Some(value) => Ok(Some(integer(value, name)?)),
    }
}

fn map_error(error: ace_store::reads::long_thread::common::LongError) -> napi::Error {
    match error {
        ace_store::reads::long_thread::common::LongError::Sqlite(error) => fail(error),
        ace_store::reads::long_thread::common::LongError::Invalid(message) => {
            napi::Error::from_reason(message)
        }
    }
}

#[napi]
impl NativeDatabase {
    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn long_turns_page(
        &self,
        thread_id: String,
        before: Option<f64>,
        after: Option<f64>,
        limit: f64,
        request_id: String,
        head_seq: f64,
    ) -> napi::Result<String> {
        let result = (|| {
            turns_page(
                self.connection(),
                &thread_id,
                optional_integer(before, "before")?,
                optional_integer(after, "after")?,
                integer(limit, "limit")?,
                &request_id,
                integer(head_seq, "head")?,
            )
            .map_err(map_error)
        })();
        result.map_err(|error: napi::Error| error)
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn long_turn_steps(
        &self,
        thread_id: String,
        turn_ordinal: f64,
        after: Option<f64>,
        limit: f64,
        request_id: String,
        head_seq: f64,
    ) -> napi::Result<String> {
        turn_steps(
            self.connection(),
            &thread_id,
            integer(turn_ordinal, "turn")?,
            optional_integer(after, "after")?,
            integer(limit, "limit")?,
            &request_id,
            integer(head_seq, "head")?,
        )
        .map_err(map_error)
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn long_thread_search(
        &self,
        thread_id: String,
        request_id: String,
        text: String,
        scope: String,
        filter: Option<String>,
        limit: f64,
        cursor: Option<String>,
        thread_ids: Vec<String>,
        head_seq: f64,
    ) -> napi::Result<String> {
        thread_search(
            self.connection(),
            &thread_id,
            &request_id,
            &text,
            &scope,
            filter.as_deref(),
            integer(limit, "limit")?,
            cursor.as_deref(),
            &thread_ids,
            integer(head_seq, "head")?,
        )
        .map_err(map_error)
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn long_thread_catch_up(
        &self,
        thread_id: String,
        request_id: String,
        since_seq: Option<f64>,
        since_time: Option<f64>,
        family: Vec<String>,
        head_seq: f64,
    ) -> napi::Result<String> {
        thread_catch_up(
            self.connection(),
            &thread_id,
            &request_id,
            optional_integer(since_seq, "since")?,
            optional_integer(since_time, "since")?,
            &family,
            integer(head_seq, "head")?,
        )
        .map_err(map_error)
    }
}
