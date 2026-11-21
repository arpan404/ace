// SPDX-License-Identifier: Apache-2.0

//! `sessionTitle` (`packages/history-import/src/user-text.ts`).

use std::sync::LazyLock;

use regex::Regex;

use crate::js;
use crate::sanitize::sanitize_user_text;

#[allow(clippy::expect_used)]
fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a constant pattern")
}

static TAG: LazyLock<Regex> = LazyLock::new(|| compile(r"<[^>]*(?:>|$)"));
static UNTITLED: LazyLock<Regex> = LazyLock::new(|| {
    compile(r"(?i)^(?:untitled(?: session)?|new session(?: - [^\n\r\x{2028}\x{2029}]*)?)$")
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| compile(&format!("[{}]+", js::SPACE_CLASS)));

fn clean(text: &str) -> String {
    js::trim(&TAG.replace_all(&sanitize_user_text(text), "")).to_owned()
}

/// The title a saved session shows: the provider's own unless it is a placeholder, else the
/// first prompt, else the day it was last active.
pub fn session_title(preferred: &str, prompt: &str, at: i64) -> String {
    let preferred = clean(preferred);
    let title = if !preferred.is_empty() && !UNTITLED.is_match(&preferred) {
        preferred
    } else {
        clean(prompt)
    };
    let collapsed = SPACES.replace_all(&title, " ");
    let title = js::prefix(&collapsed, 256);
    if title.is_empty() {
        format!("Session from {}", js::iso_day(at))
    } else {
        title.to_owned()
    }
}
