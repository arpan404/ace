// SPDX-License-Identifier: Apache-2.0
//! `failure-copy.ts`: what a failed request was, in the person's words, and why a send that never
//! started was kept. Moved cases: `open-failure.process.test.ts`'s refused-CLI, unavailable-model
//! and Git-fence cases.

use ace_json::Value;

const TITLES: [(&str, &str); 10] = [
    ("thread.interrupt", "Couldn't stop the agent"),
    ("thread.resume", "Couldn't resume"),
    ("queue.resume", "Couldn't resume the queue"),
    ("thread.limit", "Couldn't resume after the limit"),
    ("thread.switch", "Couldn't switch the model"),
    ("thread.merge", "Couldn't merge the fork"),
    ("thread.fork", "Couldn't fork the thread"),
    ("thread.archive", "Couldn't archive the thread"),
    ("interaction.resolve", "Couldn't send your answer"),
    ("background_task.stop", "Couldn't stop the background task"),
];

/// Why a Cursor thread can't move to another provider or account in place (ADR 0043).
pub const ACP_AGENT_REQUIRED: &str = "Choose the agent to switch to from the model picker.";
pub const SWITCH_NEEDS_NEW_THREAD: &str = "Cursor keeps this conversation on its own account. Send your next message to continue in a new thread with this context.";

/// The failed request named by what the person asked for.
pub fn failed_action_title(kind: &str) -> &'static str {
    TITLES
        .iter()
        .find(|(named, _)| *named == kind)
        .map(|(_, title)| *title)
        .unwrap_or("Couldn't finish that")
}

/// The failure's first line, short enough to read inline beside the title. TypeScript's `.length`
/// and `.slice` count UTF-16 units (rule 17), so the cut can fall inside a pair.
pub fn failure_reason(message: &str) -> ace_json::JsString {
    let line = message
        .split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let text = ace_json::JsString::from(line);
    if text.len_utf16() > 160 {
        let mut cut = text.slice_units(0, 159);
        cut.push_str("\u{2026}");
        cut
    } else {
        text
    }
}

/// Why a send that never started was kept, as the held queue shows it: its code and title.
pub fn retained_failure(
    message: &str,
    unavailable: bool,
    details: Option<&Value>,
) -> (String, String) {
    let code = details
        .and_then(|details| details.get("code"))
        .and_then(Value::as_str);
    let detail = details
        .and_then(|details| details.get("detail"))
        .and_then(Value::as_str);
    // The installed CLI is a version ace refuses: say which, never "check your connection".
    if matches!(code, Some("cli_unsupported") | Some("cli_too_old"))
        && let Some(detail) = detail
    {
        return (
            code.unwrap_or_default().to_owned(),
            failure_reason(detail).to_string_lossy().into_owned(),
        );
    }
    let selected = match code {
        Some("resume_unavailable") => Some((
            "resume_unavailable",
            "The previous provider session could not be resumed. Start a new thread and include the context you need.",
        )),
        Some("account_home_unanswered") => Some((
            "account_home_unanswered",
            "This account's folder isn't answering, so ace didn't start the turn on it or on another account. Your message is kept; resume once the folder answers.",
        )),
        Some("worktree_missing") => Some((
            "worktree_missing",
            "This thread's folder is gone. Your message is kept and sends once you move the thread to the local checkout or make its worktree again.",
        )),
        Some("git_quarantined") => Some((
            "git_quarantined",
            "A stale Git lock blocks this checkout. If nothing is still changing it, clear the stale lock, then try again.",
        )),
        Some("git_timeout") => Some((
            "git_timeout",
            "Git took too long to prepare this checkout. Your message is kept. Try again when local Git work finishes.",
        )),
        Some(code) if code.starts_with("git_") => Some((
            code,
            "Git could not prepare this checkout. Your message is kept. Check Details, then try again.",
        )),
        _ if unavailable => Some((
            "model_unavailable",
            "The selected model is unavailable. Choose another model.",
        )),
        _ => None,
    };
    match selected {
        Some((code, title)) => (code.to_owned(), title.to_owned()),
        None => (
            "delivery_failed".to_owned(),
            if message.contains("Context preparation is unavailable") {
                "Your attachments could not be prepared. Try again when the connection is ready."
                    .to_owned()
            } else {
                "The provider could not accept your message. Check your connection and sign-in, then try again."
                    .to_owned()
            },
        ),
    }
}
