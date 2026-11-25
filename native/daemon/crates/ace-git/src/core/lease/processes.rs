// SPDX-License-Identifier: Apache-2.0
//! A live Git process and whether it works in a root
//! (`packages/git/src/git-processes.ts`). The scan itself is the injected
//! `gitProcesses` port, called back on the JS thread.

use std::path::Path;

use crate::core::paths::within;

/// A live Git process on this machine and the directory it runs in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitProcess {
    pub pid: u32,
    /// Absent when the process can't be inspected: it may be working anywhere.
    pub cwd: Option<String>,
    /// The checkout `cwd` belongs to: the nearest directory with a `.git` entry.
    pub checkout: Option<String>,
    /// When it started, epoch milliseconds, rounded down. Absent when unknown.
    pub started_at: Option<i64>,
    /// Whether its process group is led by a Git process. Absent when unknown.
    pub git_group: Option<bool>,
}

impl GitProcess {
    /// Reads one entry of the `gitProcesses` port's listing.
    pub fn from_json(value: &ace_json::Value) -> Option<Self> {
        let ace_json::Value::Object(map) = value else {
            return None;
        };
        let pid = match map.get("pid") {
            Some(ace_json::Value::Number(number)) => number.as_f64()?,
            _ => return None,
        };
        Some(Self {
            pid: pid as u32,
            cwd: string_field(map, "cwd"),
            checkout: string_field(map, "checkout"),
            started_at: match map.get("startedAt") {
                Some(ace_json::Value::Number(number)) => {
                    number.as_f64().map(|value| value.round() as i64)
                }
                _ => None,
            },
            git_group: match map.get("gitGroup") {
                Some(ace_json::Value::Bool(value)) => Some(*value),
                _ => None,
            },
        })
    }
}

fn string_field(map: &ace_json::Map, key: &str) -> Option<String> {
    match map.get(key) {
        Some(ace_json::Value::String(text)) => Some(text.to_string_lossy().into_owned()),
        _ => None,
    }
}

/// Whether `process` works in any of `roots`, or is a clone creating one of
/// them. Git in a checkout nested inside a root (an agent's linked worktree,
/// say) works in that checkout only.
pub fn touches(process: &GitProcess, roots: &[String]) -> bool {
    let Some(cwd) = process.cwd.as_deref() else {
        return true;
    };
    roots.iter().any(|root| {
        cwd == parent_of(root)
            || match process.checkout.as_deref() {
                None => within(root, cwd),
                Some(checkout) => checkout == root,
            }
    })
}

fn parent_of(path: &str) -> &str {
    Path::new(path)
        .parent()
        .and_then(|parent| parent.to_str())
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(cwd: Option<&str>, checkout: Option<&str>) -> GitProcess {
        GitProcess {
            pid: 1,
            cwd: cwd.map(str::to_owned),
            checkout: checkout.map(str::to_owned),
            ..GitProcess::default()
        }
    }

    #[test]
    fn a_process_with_no_working_directory_may_work_anywhere() {
        assert!(touches(&process(None, None), &["/repos/ace".to_owned()]));
    }

    #[test]
    fn a_process_works_in_its_own_checkout_and_not_in_a_sibling_worktree() {
        let roots = vec!["/repos/ace/x".to_owned()];
        assert!(touches(
            &process(Some("/repos/ace/x/sub"), Some("/repos/ace/x")),
            &roots
        ));
        assert!(!touches(
            &process(Some("/repos/ace/y"), Some("/repos/ace/y")),
            &roots
        ));
        // A clone in the root's parent creates it.
        assert!(touches(&process(Some("/repos/ace"), None), &roots));
    }

    #[test]
    fn a_process_without_a_known_checkout_works_inside_the_root_by_path() {
        let roots = vec!["/repos/ace".to_owned()];
        assert!(touches(&process(Some("/repos/ace/pkg"), None), &roots));
        assert!(!touches(&process(Some("/repos/ace-other"), None), &roots));
    }
}
