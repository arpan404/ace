//! Commands from Spade's own classifier, effect and autonomy tests, labelled by Spade's own rules:
//! every string literal in those test files that reads as a command (it parses, and starts with
//! a program the generator or the rules know) is assessed by the shell classifier, and its
//! finding becomes its label. What the rules can't name (unclear, a script they can't show) is
//! left out: there is no known intent for it.

use std::path::Path;

use spade_core::autonomy::Sensitive;
use spade_core::autonomy::shell::{self, Finding, Lexical};
use spade_core::effect::Effect;

/// The test files read, from the `spade` folder.
pub const FILES: &[&str] = &[
    "crates/spade-core/src/autonomy/shell/tests.rs",
    "crates/spade-core/src/autonomy/tests.rs",
    "crates/spade-core/src/autonomy/secrets.rs",
    "crates/spade-core/src/effect/tests.rs",
    "crates/spade-server/tests/autonomy.rs",
    "crates/spade-server/tests/autonomy_scripts.rs",
    "crates/spade-server/tests/effects.rs",
    "crates/spade-server/tests/workspace_shell.rs",
];

/// Every string literal in Rust source: `"…"` with its escapes, and raw `r"…"`, `r#"…"#`.
pub fn literals(source: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // Comments.
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        // A char literal like '"' must not open a string.
        if c == '\'' && chars.get(i + 2) == Some(&'\'') {
            i += 3;
            continue;
        }
        if c == '\'' && chars.get(i + 1) == Some(&'\\') && chars.get(i + 3) == Some(&'\'') {
            i += 4;
            continue;
        }
        if c == 'r'
            && matches!(chars.get(i + 1), Some('"' | '#'))
            && !ident(chars.get(i.wrapping_sub(1)))
        {
            let mut hashes = 0;
            let mut j = i + 1;
            while chars.get(j) == Some(&'#') {
                hashes += 1;
                j += 1;
            }
            if chars.get(j) == Some(&'"') {
                let start = j + 1;
                let mut k = start;
                while k < chars.len() {
                    if chars[k] == '"' && (0..hashes).all(|h| chars.get(k + 1 + h) == Some(&'#')) {
                        break;
                    }
                    k += 1;
                }
                out.push(chars[start..k.min(chars.len())].iter().collect());
                i = k + 1 + hashes;
                continue;
            }
        }
        if c == '"' {
            let mut text = String::new();
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '"' {
                if chars[j] == '\\' {
                    j += 1;
                    match chars.get(j) {
                        Some('n') => text.push('\n'),
                        Some('t') => text.push('\t'),
                        Some('\\') => text.push('\\'),
                        Some('"') => text.push('"'),
                        Some('\'') => text.push('\''),
                        Some('0') => text.push('\0'),
                        Some('\n') => {
                            // A line continuation: skip the next line's indent.
                            while matches!(chars.get(j + 1), Some(' ' | '\t')) {
                                j += 1;
                            }
                        }
                        Some('u') => {
                            let close = (j..chars.len()).find(|&k| chars[k] == '}').unwrap_or(j);
                            let hex: String = chars[(j + 2).min(close)..close].iter().collect();
                            if let Some(ch) =
                                u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32)
                            {
                                text.push(ch);
                            }
                            j = close;
                        }
                        Some(other) => text.push(*other),
                        None => {}
                    }
                } else {
                    text.push(chars[j]);
                }
                j += 1;
            }
            out.push(text);
            i = j + 1;
            continue;
        }
        i += 1;
    }
    out
}

fn ident(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric() || *c == '_')
}

/// What the rules say a command does; `None` when they can't name it.
pub fn label(command: &str) -> Option<Effect> {
    let assessed = shell::assess(command, &Lexical);
    match assessed.finding {
        Some(Finding::Credentials) => Some(Effect::Credential),
        Some(Finding::Sensitive(kind)) => match kind {
            Sensitive::Payment => Some(Effect::Pay),
            Sensitive::MessageAsPerson => Some(Effect::SendAsPerson),
            Sensitive::Publish | Sensitive::RemoteChange => Some(Effect::Publish),
            Sensitive::Network
            | Sensitive::WriteOutside
            | Sensitive::DeleteOutside
            | Sensitive::Admin => Some(Effect::Network),
            Sensitive::Automation => Some(Effect::Drive),
            Sensitive::Credentials => Some(Effect::ChangeAccess),
            Sensitive::Unclear
            | Sensitive::UnseenScript
            | Sensitive::Unknown
            | Sensitive::TaintedRoutine => None,
        },
        None if !assessed.shown.is_empty() => None,
        None => Some(local(command)),
    }
}

/// A command the rules found nothing in: a write in the folder when it plainly writes, else a
/// read.
pub fn local(command: &str) -> Effect {
    const WRITES: &[&str] = &[
        "mkdir", "touch", "cp", "mv", "rm", "tee", "ln", "chmod", "cargo", "npm", "pnpm", "yarn",
        "pip", "go", "make", "bun", "tar", "unzip", "wget", "git", "sed", "python", "python3",
        "node", "dd", "rsync",
    ];
    let writes = shell::read(command).is_some_and(|commands| {
        commands.iter().any(|c| {
            !c.writes_to.is_empty()
                || c.words
                    .first()
                    .is_some_and(|w| WRITES.contains(&w.rsplit('/').next().unwrap_or(w)))
        })
    });
    if writes {
        Effect::WriteLocal
    } else {
        Effect::Read
    }
}

/// The labelled commands in Spade's test files under `root` (the `spade` folder), keeping
/// those whose first program is in `programs`.
pub fn commands(root: &Path, programs: &[String]) -> Vec<(String, Effect)> {
    let mut out: Vec<(String, Effect)> = Vec::new();
    for file in FILES {
        let Ok(source) = std::fs::read_to_string(root.join(file)) else {
            continue;
        };
        for literal in literals(&source) {
            let trimmed = literal.trim();
            if trimmed.len() < 2 || trimmed.len() > 600 || out.iter().any(|(c, _)| c == trimmed) {
                continue;
            }
            let Some(parsed) = shell::read(trimmed) else {
                continue;
            };
            let first = parsed
                .first()
                .and_then(|c| c.words.first())
                .map(|w| w.rsplit('/').next().unwrap_or(w).to_owned());
            if !first.is_some_and(|p| programs.contains(&p)) {
                continue;
            }
            if let Some(effect) = label(trimmed) {
                out.push((trimmed.to_owned(), effect));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_literals_are_read_with_their_escapes() {
        let source = r##"let a = "curl -d \"x\" y"; // "not this"
let b = r#"git push "origin""#; let c = '"';"##;
        assert_eq!(literals(source), ["curl -d \"x\" y", "git push \"origin\""]);
    }

    #[test]
    fn the_rules_label_what_they_can_name() {
        assert_eq!(label("git push origin main"), Some(Effect::Publish));
        assert_eq!(label("cat ~/.ssh/id_rsa"), Some(Effect::Credential));
        assert_eq!(label("ls -la"), Some(Effect::Read));
        assert_eq!(label("eval \"$X\""), None);
    }
}
