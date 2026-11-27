// SPDX-License-Identifier: Apache-2.0
//! Reviewer hooks (`packages/git/src/reviewer-hooks.ts` and
//! `hook-command-words.ts`, G2c): whether a hook Git would run in a pull
//! request's checkout is the PR author's program, and the Windows word reader
//! that tells what a configured `hook.<name>.command` names.
//!
//! `reviewer-hooks-identity.ts` (the Windows file-identity variant) waits for
//! the Windows gate: it compares volume and file ids, which this host cannot
//! prove.

use crate::core::credentials::{ConfigOutput, GitQuery};

pub mod words;

use crate::core::error::GitError;
use crate::core::paths;
pub use words::{
    HookWord, ShellLayout, git_install, hook_command_words, msys_paths, names_path, needs_install,
    word_paths,
};

/// ECMAScript's `\s`: WhiteSpace plus LineTerminator. It is not ASCII — U+00A0 and U+FEFF
/// split, while U+0085 (which Rust's `is_whitespace` also splits on) does not.
pub(crate) fn js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Trim ECMAScript whitespace from both ends, as `String.prototype.trim` does.
pub(crate) fn ecma_trim(value: &str) -> &str {
    ecma_trim_end(ecma_trim_start(value))
}

pub(crate) fn ecma_trim_start(value: &str) -> &str {
    let mut start = 0usize;
    for character in value.chars() {
        if js_whitespace(character) {
            start += character.len_utf8();
        } else {
            break;
        }
    }
    &value[start..]
}

pub(crate) fn ecma_trim_end(value: &str) -> &str {
    let mut end = value.len();
    while end > 0 {
        let Some(character) = value[..end].chars().next_back() else {
            break;
        };
        if js_whitespace(character) {
            end -= character.len_utf8();
        } else {
            break;
        }
    }
    &value[..end]
}

/// The paths a configured hook command names: every word holding a `/`, quotes removed, read
/// against the working tree root (where Git runs hooks). A bare program name on PATH names none.
pub fn hook_command_paths(command: &str, top: &str) -> Vec<String> {
    command
        .split(js_whitespace)
        .map(|word| {
            let word = word.strip_prefix(['\'', '"']).unwrap_or(word);
            word.strip_suffix(['\'', '"']).unwrap_or(word)
        })
        .filter(|word| word.contains('/'))
        .map(|word| paths::resolve(top, word))
        .collect()
}

/// `path` is `root` or lies under it.
fn under(path: &str, root: &str) -> bool {
    if path == root {
        return true;
    }
    if root.ends_with('/') {
        path.starts_with(root)
    } else {
        path.starts_with(&format!("{root}/"))
    }
}

fn text(output: &ConfigOutput) -> String {
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    paths::strip_terminator(&text, false).to_owned()
}

fn arguments(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

fn real_path(path: &str) -> String {
    paths::canonical(path).unwrap_or_else(|_| path.to_owned())
}

/// Whether a hook Git would run in the checkout at `cwd` lives inside it: the hooks directory
/// (a relative `core.hooksPath` such as `.husky`), or a configured `hook.<name>.command` naming a
/// file in the working tree. Inside a pull request's checkout either is its author's program.
pub async fn hooks_inside_checkout(query: &dyn GitQuery, cwd: &str) -> Result<bool, GitError> {
    let (hooks, top, common, commands) = tokio::try_join!(
        query.query(&arguments(&["rev-parse", "--git-path", "hooks"])),
        query.query(&arguments(&[
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel"
        ])),
        query.query(&arguments(&[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir"
        ])),
        query.query(&arguments(&[
            "config",
            "--null",
            "--get-regexp",
            "^hook\\..*\\.command$"
        ])),
    )?;
    let root = match text(&top) {
        empty if empty.is_empty() => cwd.to_owned(),
        top => top,
    };
    let roots = [root.clone(), real_path(&root)];
    // The repository's own Git directory (its `hooks`) is not the checkout's content, even in a
    // main checkout where it sits inside the working tree.
    let own = text(&common);
    let owned: Vec<String> = if own.is_empty() {
        Vec::new()
    } else {
        vec![own.clone(), real_path(&own)]
    };
    let lexical = paths::resolve(cwd, &text(&hooks));
    let named: Vec<String> = if commands.exit_code == 0 {
        String::from_utf8_lossy(&commands.stdout)
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .flat_map(|entry| {
                let command = entry
                    .find('\n')
                    .map_or(entry, |newline| &entry[newline + 1..]);
                hook_command_paths(command, &root)
            })
            .collect()
    } else {
        Vec::new()
    };
    let mut candidates = vec![lexical];
    candidates.extend(named);
    let resolved: Vec<String> = candidates.iter().map(|path| real_path(path)).collect();
    let paths: Vec<&String> = candidates.iter().chain(resolved.iter()).collect();
    Ok(paths.into_iter().any(|path| {
        roots.iter().any(|each| under(path, each)) && !owned.iter().any(|each| under(path, each))
    }))
}

#[cfg(test)]
mod tests;
