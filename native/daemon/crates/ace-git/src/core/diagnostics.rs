// SPDX-License-Identifier: Apache-2.0
//! Bounded streaming stderr + Trace2 diagnostics classifier.
//! Ported from `packages/git/src/diagnostics.ts` (G2a).

use std::collections::HashSet;
use std::sync::OnceLock;

use ace_json::Value;
use regex::Regex;

use crate::core::error::GitErrorCode;

const CHUNK_STEP: usize = 4096;
const TAIL_LIMIT: usize = 8192;
const HOOK_LIMIT: usize = 64;
const SID_MAX_LEN: usize = 1024;

struct Patterns {
    causes: Vec<(GitErrorCode, Regex)>,
    nothing_to_commit: Regex,
    objects_unavailable: Regex,
    auth_failed: Regex,
    remote_unreachable: Regex,
    conflicts: Regex,
    lock_file: Regex,
    hook_failed: Regex,
}

fn compile(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}

fn patterns() -> Option<&'static Patterns> {
    static PATTERNS: OnceLock<Option<Patterns>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            let causes = vec![
                (
                    GitErrorCode::ProtectedBranch,
                    compile(
                        r"(?i)protected branch|GH006|not allowed to (?:push|force push) (?:code )?to (?:protected|this) branch",
                    )?,
                ),
                (
                    GitErrorCode::BranchCheckedOut,
                    compile(r"(?i)is already (?:checked out|used by worktree) at")?,
                ),
                (
                    GitErrorCode::RefConflict,
                    compile(r"(?i)cannot lock ref '[^']*': '[^']*' exists; cannot create")?,
                ),
                (
                    GitErrorCode::PathExists,
                    compile(r"(?m)^fatal: '[^\n]*' already exists$")?,
                ),
                (
                    GitErrorCode::IdentityMissing,
                    compile(
                        r"(?i)author identity unknown|please tell me who you are|empty ident name|unable to auto-detect email address|no email was given",
                    )?,
                ),
                (
                    GitErrorCode::UnbornHead,
                    compile(
                        r"(?im)does not have any commits yet|ambiguous argument 'HEAD'|invalid reference: HEAD|not a valid object name:? '?HEAD'?$",
                    )?,
                ),
                (
                    GitErrorCode::PushRejected,
                    compile(
                        r"(?i)\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)|updates were rejected because the (?:tip|remote)",
                    )?,
                ),
                (
                    GitErrorCode::NothingToCommit,
                    compile(
                        r"(?m)^(?:nothing to commit|nothing added to commit|no changes added to commit)\b",
                    )?,
                ),
            ];
            Some(Patterns {
                causes,
                nothing_to_commit: compile(
                    r"(?m)^(?:nothing to commit|nothing added to commit|no changes added to commit)\b",
                )?,
                objects_unavailable: compile(
                    r"(?i)unable to read (?:sha(?:1|256) file|tree|object)|failed to unpack tree object|missing (?:blob|tree|object)|could not fetch .* from promisor remote|could not read [a-f0-9]{40,64}|bad object [a-f0-9]{40,64}",
                )?,
                auth_failed: compile(
                    r"(?i)authentication failed|could not read (Username|Password)|permission denied \(publickey\)|authorization failed|HTTP[^\n]*40[13]|returned error: 40[13]|access denied",
                )?,
                remote_unreachable: compile(
                    r"(?i)could not resolve (host|hostname)|failed to connect|couldn't connect|connection refused|network is unreachable",
                )?,
                conflicts: compile(r"(?i)CONFLICT|unmerged files|resolve your current index")?,
                lock_file: compile(r"Unable to create '([^'\n]+\.lock)': File exists")?,
                hook_failed: compile(r"(?i)hook[^\n]*(failed|declined)|pre-receive hook declined")?,
            })
        })
        .as_ref()
}

/// Specific causes outrank the generic hook, auth, conflict and network fallbacks.
const PRECEDENCE: &[GitErrorCode] = &[
    GitErrorCode::BranchCheckedOut,
    GitErrorCode::RefConflict,
    GitErrorCode::PathExists,
    GitErrorCode::IdentityMissing,
    GitErrorCode::UnbornHead,
    GitErrorCode::PushRejected,
    GitErrorCode::NothingToCommit,
];

/// Incremental UTF-8 decoder matching Node's `StringDecoder("utf8")`.
#[derive(Default)]
struct Utf8StreamDecoder {
    pending: [u8; 4],
    pending_len: usize,
}

impl Utf8StreamDecoder {
    fn write(&mut self, input: &[u8]) -> String {
        let mut out = String::new();
        let mut slice = input;
        if self.pending_len > 0 {
            let mut combined = [0u8; 8];
            combined[..self.pending_len].copy_from_slice(&self.pending[..self.pending_len]);
            let take = slice.len().min(4);
            combined[self.pending_len..self.pending_len + take].copy_from_slice(&slice[..take]);
            let total = self.pending_len + take;
            match std::str::from_utf8(&combined[..total]) {
                Ok(valid) => {
                    out.push_str(valid);
                    self.pending_len = 0;
                    slice = &slice[take..];
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        if let Ok(valid) = std::str::from_utf8(&combined[..valid_up_to]) {
                            out.push_str(valid);
                        }
                        if valid_up_to >= self.pending_len {
                            let consumed_from_input = valid_up_to - self.pending_len;
                            self.pending_len = 0;
                            slice = &slice[consumed_from_input..];
                        } else {
                            let remain = self.pending_len - valid_up_to;
                            self.pending.copy_within(valid_up_to..self.pending_len, 0);
                            self.pending_len = remain;
                        }
                    }
                    if let Some(error_len) = err.error_len() {
                        out.push('\u{FFFD}');
                        let skip = valid_up_to + error_len;
                        if skip >= self.pending_len {
                            let consumed_from_input = skip - self.pending_len;
                            self.pending_len = 0;
                            slice = &slice[consumed_from_input.min(slice.len())..];
                        } else {
                            let remain = self.pending_len - skip;
                            self.pending.copy_within(skip..self.pending_len, 0);
                            self.pending_len = remain;
                        }
                    } else if valid_up_to == 0 {
                        // Still incomplete; store everything we have.
                        self.pending[..total].copy_from_slice(&combined[..total]);
                        self.pending_len = total;
                        return out;
                    }
                }
            }
        }
        loop {
            match std::str::from_utf8(slice) {
                Ok(valid) => {
                    out.push_str(valid);
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0
                        && let Ok(valid) = std::str::from_utf8(&slice[..valid_up_to])
                    {
                        out.push_str(valid);
                    }
                    slice = &slice[valid_up_to..];
                    if let Some(error_len) = err.error_len() {
                        out.push('\u{FFFD}');
                        slice = &slice[error_len..];
                    } else {
                        let len = slice.len().min(4);
                        self.pending[..len].copy_from_slice(&slice[..len]);
                        self.pending_len = len;
                        break;
                    }
                }
            }
        }
        out
    }

    fn end(&mut self) -> String {
        if self.pending_len == 0 {
            return String::new();
        }
        let s = String::from_utf8_lossy(&self.pending[..self.pending_len]).into_owned();
        self.pending_len = 0;
        s
    }
}

/// Inspect the entire stderr stream with bounded line storage and bounded active hook identities.
#[derive(Default)]
pub struct GitDiagnostics {
    decoder: Utf8StreamDecoder,
    tail: String,
    discarded_trace: bool,
    hooks: HashSet<String>,
    hook_failed: bool,
    hook_exited: bool,
    auth_failed: bool,
    conflicts: bool,
    remote_unreachable: bool,
    objects_unavailable: bool,
    causes: HashSet<GitErrorCode>,
    /// The Git lock file another process held, when Git failed because it exists.
    pub lock_file: Option<String>,
}

impl GitDiagnostics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn accept(&mut self, chunk: &[u8]) {
        for piece in chunk.chunks(CHUNK_STEP) {
            let decoded = self.decoder.write(piece);
            self.text(&decoded);
        }
    }

    /// Some commands (`git commit`) report their failure on stdout. Only bounded tails are passed.
    pub fn accept_output(&mut self, text: &str) {
        if let Some(pats) = patterns()
            && pats.nothing_to_commit.is_match(text)
        {
            self.causes.insert(GitErrorCode::NothingToCommit);
        }
    }

    pub fn finish(&mut self) -> GitErrorCode {
        let flushed = self.decoder.end();
        if !flushed.is_empty() {
            self.text(&flushed);
        }
        let remaining = std::mem::take(&mut self.tail);
        self.line(&remaining);
        if self.causes.contains(&GitErrorCode::ProtectedBranch) {
            return GitErrorCode::ProtectedBranch;
        }
        if self.hook_exited {
            return GitErrorCode::HookFailed;
        }
        for &cause in PRECEDENCE {
            if self.causes.contains(&cause) {
                return cause;
            }
        }
        if self.hook_failed {
            GitErrorCode::HookFailed
        } else if self.auth_failed {
            GitErrorCode::AuthFailed
        } else if self.conflicts {
            GitErrorCode::Conflicts
        } else if self.objects_unavailable {
            GitErrorCode::ObjectsNotAvailable
        } else if self.remote_unreachable {
            GitErrorCode::RemoteUnreachable
        } else {
            GitErrorCode::GitFailed
        }
    }

    fn text(&mut self, incoming: &str) {
        let mut combined = String::with_capacity(self.tail.len() + incoming.len());
        combined.push_str(&self.tail);
        combined.push_str(incoming);
        let mut parts = combined.split('\n').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_some() {
                self.line(part);
                self.discarded_trace = false;
            } else {
                self.tail = part.to_owned();
            }
        }
        if utf16_len(&self.tail) > TAIL_LIMIT {
            if self.tail.contains("{\"event\"") {
                self.discarded_trace = true;
            }
            if !self.discarded_trace {
                let snapshot = self.tail.clone();
                self.plain(&snapshot);
            }
            self.tail = tail_utf16_suffix(&self.tail, TAIL_LIMIT);
        }
    }

    fn line(&mut self, line: &str) {
        if let Some(start) = line.rfind("{\"event\"") {
            if start > 0 {
                self.plain(&line[..start]);
            }
            self.parse_trace(&line[start..]);
            return;
        }
        if !self.discarded_trace {
            self.plain(line);
        }
    }

    fn parse_trace(&mut self, slice: &str) {
        let Ok(Value::Object(obj)) = ace_json::parse(slice) else {
            return;
        };
        let Some(Value::String(event)) = obj.get("event") else {
            return;
        };
        let event = event.as_str();
        let sid = match obj.get("sid") {
            None => "",
            Some(Value::String(s)) => {
                let text = s.as_str();
                if utf16_len(text) > SID_MAX_LEN {
                    return;
                }
                text
            }
            Some(_) => return,
        };
        let Some(child_id) = obj.get("child_id").and_then(json_int) else {
            return;
        };
        let child_class = match obj.get("child_class") {
            None => None,
            Some(Value::String(s)) => Some(s.as_str()),
            Some(_) => return,
        };
        let code = match obj.get("code") {
            None => None,
            Some(v) => {
                let Some(n) = json_int(v) else {
                    return;
                };
                Some(n)
            }
        };
        let key = format!("{sid}:{child_id}");
        if event == "child_start" && child_class == Some("hook") && self.hooks.len() < HOOK_LIMIT {
            self.hooks.insert(key);
        } else if event == "child_exit"
            && self.hooks.remove(&key)
            && let Some(exit_code) = code
            && exit_code != 0
        {
            self.hook_exited = true;
        }
    }

    fn plain(&mut self, text: &str) {
        let Some(pats) = patterns() else {
            return;
        };
        if pats.objects_unavailable.is_match(text) {
            self.objects_unavailable = true;
        }
        if pats.auth_failed.is_match(text) {
            self.auth_failed = true;
        }
        if pats.remote_unreachable.is_match(text) {
            self.remote_unreachable = true;
        }
        if pats.conflicts.is_match(text) {
            self.conflicts = true;
        }
        if self.lock_file.is_none()
            && let Some(caps) = pats.lock_file.captures(text)
            && let Some(m) = caps.get(1)
        {
            self.lock_file = Some(m.as_str().to_owned());
        }
        if pats.hook_failed.is_match(text) {
            self.hook_failed = true;
        }
        for (cause, pattern) in &pats.causes {
            if pattern.is_match(text) {
                self.causes.insert(*cause);
            }
        }
    }
}

fn json_int(value: &Value) -> Option<i64> {
    let Value::Number(num) = value else {
        return None;
    };
    num.as_i64()
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn tail_utf16_suffix(s: &str, max_units: usize) -> String {
    let mut units = 0usize;
    let mut start = s.len();
    for (idx, ch) in s.char_indices().rev() {
        let w = ch.len_utf16();
        if units + w > max_units {
            break;
        }
        units += w;
        start = idx;
    }
    s[start..].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify(stderr: &str) -> GitErrorCode {
        let mut diagnostics = GitDiagnostics::new();
        diagnostics.accept(stderr.as_bytes());
        diagnostics.finish()
    }

    // Ported from packages/git/src/diagnostics.test.ts (b)
    #[test]
    fn push_failures_are_classified_by_stderr_cause() {
        let cases = [
            (
                "fatal: Authentication failed for https://token@example.org/private",
                GitErrorCode::AuthFailed,
            ),
            (
                "fatal: private /home/user/repo failed",
                GitErrorCode::GitFailed,
            ),
            (
                "fatal: Could not resolve host: example.invalid",
                GitErrorCode::RemoteUnreachable,
            ),
        ];
        for (stderr, expected) in cases {
            assert_eq!(classify(stderr), expected, "stderr: {stderr}");
        }
    }

    // Ported from packages/git/src/diagnostics.test.ts (b)
    #[test]
    fn successful_hook_traces_do_not_misclassify_a_subsequent_command_failure() {
        let stream = format!(
            "{}\n{}\nfatal: unrelated command failure\n",
            r#"{"event":"child_start","sid":"a","child_id":0,"child_class":"hook"}"#,
            r#"{"event":"child_exit","sid":"a","child_id":0,"code":0}"#,
        );
        assert_eq!(classify(&stream), GitErrorCode::GitFailed);
    }

    #[test]
    fn failing_hook_trace_classifies_as_hook_failed_and_extracts_lock_file() {
        let mut diagnostics = GitDiagnostics::new();
        let stream = format!(
            "Unable to create '/tmp/repo/.git/index.lock': File exists.\n{}\n{}\n",
            r#"{"event":"child_start","sid":"a","child_id":1,"child_class":"hook"}"#,
            r#"{"event":"child_exit","sid":"a","child_id":1,"code":1}"#,
        );
        diagnostics.accept(stream.as_bytes());
        assert_eq!(diagnostics.finish(), GitErrorCode::HookFailed);
        assert_eq!(
            diagnostics.lock_file.as_deref(),
            Some("/tmp/repo/.git/index.lock")
        );
    }
}
