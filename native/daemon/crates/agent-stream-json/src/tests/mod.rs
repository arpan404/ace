// SPDX-License-Identifier: Apache-2.0
//! The crate's unit tests, one module per source module. Fixtures are compiled in with
//! `include_str!` so a test binary needs no working directory and no provider.

mod control;
mod host;
mod launch;
mod message;

use ace_json::Value;

/// Parse a fixture or a test literal; a failure is a broken test, never provider data.
pub(super) fn parse(text: &str) -> Value {
    ace_json::parse(text).expect("the test's JSON parses")
}

/// The exact bytes [`ace_json::to_string`] writes for a value.
pub(super) fn text(value: &Value) -> String {
    ace_json::to_string(value)
}
