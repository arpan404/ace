// SPDX-License-Identifier: Apache-2.0
//! `android-ui-helper.ts`, `android-input-shell.ts` and `android-operations.ts`'s decisions: the
//! one long-running UiAutomation reader and the pinned input shell (their arguments, line
//! protocol, budgets and words), and the bounded per-device UI read queue. The shell owns the
//! processes; nothing here retries a failed action.

use crate::platform::android_ui::TreeOptions;
use crate::platform::{Error, Refusal};

/// ace's own dex, pushed to the emulator on first use.
pub const UI_HELPER_REMOTE_JAR: &str = "/data/local/tmp/ace-ui-helper.jar";
/// The tree is one line of XML; the parser's own budget is 1 MiB.
pub const UI_HELPER_REPLY_BYTES: u64 = 2 * 1024 * 1024;
/// The helper exits after this long without a request, so UiAutomation is free for test runners.
pub const UI_HELPER_IDLE_MS: u64 = 30_000;
/// How long the helper has to announce READY.
pub const UI_HELPER_STARTUP_MS: u64 = 10_000;
/// How long one tree request waits for its answer.
pub const UI_HELPER_TREE_MS: u64 = 5_000;

/// The pinned input shell keeps one line per answer, so a longer line is not the shell's.
pub const INPUT_LINE_BYTES: u64 = 4096;
/// Input queued behind one in flight; past this the action is refused rather than delayed.
pub const INPUT_QUEUE_LIMIT: usize = 32;
/// How long one input action waits for its marker.
pub const INPUT_TIMEOUT_MS: u64 = 5_000;

/// The per-device UI read queue's bound.
pub const UI_QUEUE_LIMIT: usize = 32;
/// The limits a semantic action reads the tree with.
pub fn act_tree_options() -> TreeOptions {
    TreeOptions {
        max_depth: 16,
        max_nodes: 512,
    }
}

/// `adb -s <serial> shell -T "CLASSPATH=<jar> app_process / dev.ace.uihelper.Main"`.
pub fn ui_helper_args(serial: &str) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "shell".to_string(),
        "-T".to_string(),
        format!("CLASSPATH={UI_HELPER_REMOTE_JAR} app_process / dev.ace.uihelper.Main"),
    ]
}

/// What one line of the helper's stdout says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperReply {
    /// The helper is up and holds UiAutomation.
    Ready,
    /// One answer to one request, with its `OK ` or `ERR ` prefix.
    Answer(String),
    /// A line that answers nothing.
    Ignored,
}

/// The helper speaks in lines: READY once, then one `OK <xml>` or `ERR <reason>` per request.
pub fn helper_reply(line: &str) -> HelperReply {
    if line == "READY" {
        return HelperReply::Ready;
    }
    if line.starts_with("OK ") || line.starts_with("ERR ") {
        return HelperReply::Answer(line.to_string());
    }
    HelperReply::Ignored
}

/// The XML an `OK ` answer carries, or the failure an `ERR ` answer names.
pub fn helper_tree(reply: &str) -> Result<String, Error> {
    if let Some(detail) = reply.strip_prefix("ERR ") {
        return Err(failure(format!("Android UI helper: {detail}")));
    }
    Ok(reply.get(3..).unwrap_or_default().to_string())
}

fn failure(message: String) -> Error {
    Error::Failed(crate::platform::Failure {
        code: crate::platform::Code::CommandFailed,
        message,
        hint: Refusal::word("androidHelperExited").hint.to_string(),
    })
}

/// The refusal a helper that never started, exited, or timed out gives: the message names which.
pub fn helper_failure(key: &str) -> Error {
    Refusal::word(key).into()
}

/// `adb -s <serial> shell -T`: the one pinned input shell.
pub fn input_shell_args(serial: &str) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "shell".to_string(),
        "-T".to_string(),
    ]
}

/// The marker that closes one input command; the shell prints it with the command's exit code.
pub fn input_marker(sequence: u64) -> String {
    format!("ACE_INPUT_{sequence}:")
}

/// The line the input shell writes: the command, then a printf that prints the marker and the
/// command's exit code. The program is exactly today's text, so `adb shell` reads it as written.
pub fn input_line(command: &str, marker: &str) -> String {
    format!("{command}\nprintf '\\n{marker}%s\\n' \"$?\"\n")
}

/// Whether a line answers `marker`, and whether the action succeeded.
pub fn input_answer(line: &str, marker: &str) -> Option<bool> {
    let rest = line.strip_prefix(marker)?;
    Some(rest == "0")
}

/// The refusal for an emulator whose UI is not Android's, or for a full read queue.
pub fn ui_tree_platform_refusal() -> Error {
    Refusal::word("simulatorTreeOnAndroid").into()
}

pub fn ui_queue_full() -> Error {
    Refusal::word("androidUiQueueFull").into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_typing_reuses_one_pinned_shell_and_preserves_literal_text() {
        assert_eq!(
            input_shell_args("emulator-5554"),
            vec!["-s", "emulator-5554", "shell", "-T"]
        );
        // The marker line is a program, not a quote: `adb shell` reads it as it is written.
        assert_eq!(
            input_line("text a';%stouch%spwned;%s$(pwd)", "ACE_INPUT_1:"),
            "text a';%stouch%spwned;%s$(pwd)\nprintf '\\nACE_INPUT_1:%s\\n' \"$?\"\n"
        );
        assert_eq!(input_marker(1), "ACE_INPUT_1:");
        assert_eq!(input_answer("ACE_INPUT_1:0", "ACE_INPUT_1:"), Some(true));
        assert_eq!(input_answer("ACE_INPUT_1:127", "ACE_INPUT_1:"), Some(false));
        assert_eq!(input_answer("other:0", "ACE_INPUT_1:"), None);
    }
}
