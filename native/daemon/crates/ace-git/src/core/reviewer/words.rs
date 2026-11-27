// SPDX-License-Identifier: Apache-2.0
//! The Windows sh word reader and the paths a hook command word may name
//! (`hook-command-words.ts`, G3c).

use crate::core::paths;

/// Windows: one word of a configured hook command. Git runs a command holding shell characters
/// through its MSYS sh, and runs a plain one directly, so a word is read both ways.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookWord {
    /// The word after sh removes its quotes and backslashes.
    pub shell: String,
    /// The word with quotes removed and every backslash kept, as a Windows path is written.
    pub literal: String,
    /// sh would expand it (a variable, command substitution or glob): what it names is unknown.
    pub expands: bool,
}

fn is_blank(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\n' | '\r')
}

fn is_operator(character: char) -> bool {
    matches!(character, ';' | '&' | '|' | '<' | '>' | '(' | ')')
}

fn is_glob(character: char) -> bool {
    matches!(character, '*' | '?' | '[')
}

/// Characters a backslash escapes inside double quotes; before any other it stays.
fn quoted_escape(character: char) -> bool {
    matches!(character, '$' | '`' | '"' | '\\' | '\n')
}

/// The start of a substitution or variable sh would expand.
fn expansion_start(character: char) -> bool {
    character.is_ascii_alphanumeric() || "_ {(@*#?$!-".contains(character)
}

fn current(word: &mut Option<HookWord>) -> &mut HookWord {
    word.get_or_insert_with(HookWord::default)
}

fn append(word: &mut Option<HookWord>, shell: &str, literal: &str) {
    let word = current(word);
    word.shell.push_str(shell);
    word.literal.push_str(literal);
}

/// Windows: the words of a hook command, split as sh splits them.
pub fn hook_command_words(command: &str) -> Vec<HookWord> {
    let characters: Vec<char> = command.chars().collect();
    let mut words: Vec<HookWord> = Vec::new();
    let mut word: Option<HookWord> = None;
    let mut quote: Option<char> = None;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        let next = characters.get(index + 1).copied();
        index += 1;
        if quote == Some('\'') {
            if character == '\'' {
                quote = None;
            } else {
                let text = character.to_string();
                append(&mut word, &text, &text);
            }
            continue;
        }
        if character == '\\' {
            let Some(next) = next else {
                append(&mut word, "\\", "\\");
                continue;
            };
            if quote == Some('"') && !quoted_escape(next) {
                append(&mut word, "\\", "\\");
                continue;
            }
            index += 1;
            let literal = format!("\\{next}");
            if next == '\n' {
                append(&mut word, "", &literal);
            } else {
                append(&mut word, &next.to_string(), &literal);
            }
            continue;
        }
        if character == '`' || (character == '$' && next.is_some_and(expansion_start)) {
            current(&mut word).expands = true;
        }
        if quote == Some('"') {
            if character == '"' {
                quote = None;
            } else {
                let text = character.to_string();
                append(&mut word, &text, &text);
            }
            continue;
        }
        if is_blank(character) || is_operator(character) {
            if let Some(finished) = word.take() {
                words.push(finished);
            }
            continue;
        }
        if character == '\'' || character == '"' {
            current(&mut word);
            quote = Some(character);
            continue;
        }
        if is_glob(character) {
            current(&mut word).expands = true;
        }
        let text = character.to_string();
        append(&mut word, &text, &text);
    }
    if let Some(finished) = word {
        words.push(finished);
    }
    words
}

/// A spelling that names a file, as Git's sh and POSIX checks read words: it holds a separator or
/// starts at a home directory. A bare name (`check.sh`, `C:check.sh`) is looked up on PATH.
pub fn names_path(spelling: &str) -> bool {
    spelling.contains('\\') || spelling.contains('/') || spelling.starts_with('~')
}

/// What Git for Windows' sh needs to read a rooted or `~` path.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShellLayout {
    /// The Git for Windows installation, the MSYS root `/` (from `git --exec-path`).
    pub install: Option<String>,
    /// The home directory `~` names, as Git expands it.
    pub home: Option<String>,
}

fn separator(character: char) -> bool {
    character == '\\' || character == '/'
}

/// Node's `path.win32.resolve(base, path)`.
fn win32_resolve(base: &str, path: &str) -> String {
    let rooted = path.starts_with('\\') || path.starts_with('/');
    let combined = if !paths::win32_drive(path).is_empty() {
        path.to_owned()
    } else if rooted {
        format!("{}{path}", paths::win32_drive(base))
    } else if base.is_empty() {
        path.to_owned()
    } else {
        format!("{}\\{path}", base.trim_end_matches(separator))
    };
    paths::win32_normalize(&combined)
}

/// Node's `path.win32.join(base, path)`.
fn win32_join(base: &str, path: &str) -> String {
    if path.is_empty() {
        return paths::win32_normalize(base);
    }
    if base.is_empty() {
        return paths::win32_normalize(path);
    }
    paths::win32_normalize(&format!("{}\\{path}", base.trim_end_matches(separator)))
}

/// The MSYS drive form `/(cygdrive/)?<letter>` plus the rest: the letter as a drive root.
fn msys_drive(word: &str) -> Option<(char, &str)> {
    let rest = word.strip_prefix('/')?;
    let rest = rest
        .strip_prefix("cygdrive/")
        .or_else(|| rest.strip_prefix("cygdrive\\"))
        .unwrap_or(rest);
    let mut characters = rest.chars();
    let letter = characters.next()?;
    if !letter.is_ascii_alphabetic() {
        return None;
    }
    let tail = characters.as_str();
    if tail.is_empty() || tail.starts_with('\\') || tail.starts_with('/') {
        Some((letter, tail))
    } else {
        None
    }
}

/// Where MSYS may read a `/`-rooted path: `/c/...` as drive C:, and under the installation
/// (`/bin` and `/lib` are mounts of `/usr/...`). `/cygdrive/c/...` is read both ways too. `/tmp`
/// is the user's temporary folder, which isn't known here. A UNC `//host/...` path, or one not
/// rooted at `/`, has no MSYS reading.
pub fn msys_paths(word: &str, install: Option<&str>) -> Option<Vec<String>> {
    if !word.starts_with('/') || word.starts_with("//") {
        return Some(Vec::new());
    }
    let mounted_name = word.get(1..).unwrap_or_default().to_ascii_lowercase();
    if mounted_name == "tmp"
        || mounted_name.starts_with("tmp/")
        || mounted_name.starts_with("tmp\\")
    {
        return None;
    }
    let drive = msys_drive(word);
    let mut paths = Vec::new();
    if let Some((letter, tail)) = drive {
        paths.push(win32_resolve(&format!("{letter}:\\"), &format!(".{tail}")));
    }
    let Some(install) = install else {
        return if drive.is_some() { Some(paths) } else { None };
    };
    paths.push(win32_join(install, &mounted_path(word)));
    Some(paths)
}

/// `/bin` and `/lib` as the installation mounts them (`/usr/...`); anything else unchanged.
fn mounted_path(word: &str) -> String {
    for name in ["bin", "lib"] {
        let end = 1 + name.len();
        let Some(prefix) = word.get(1..end) else {
            continue;
        };
        if !prefix.eq_ignore_ascii_case(name) {
            continue;
        }
        let tail = word.get(end..).unwrap_or_default();
        if tail.is_empty() || tail.starts_with('\\') || tail.starts_with('/') {
            return format!("/usr/{}{tail}", &word[1..end]);
        }
    }
    word.to_owned()
}

/// A rooted word that only the installation can place (not `/c/...` or a UNC path).
pub fn needs_install(word: &str) -> bool {
    let Some(rest) = word.strip_prefix('/') else {
        return false;
    };
    if rest.starts_with('/') {
        return false;
    }
    let mut characters = rest.chars();
    match characters.next() {
        Some(letter) if letter.is_ascii_alphabetic() => {
            let tail = characters.as_str();
            !(tail.is_empty() || tail.starts_with('\\') || tail.starts_with('/'))
        }
        _ => true,
    }
}

/// Every place `word` may name when Git runs a hook in `top`: as Windows reads it, and as Git's
/// MSYS sh does (`/c/...`, mounts under the installation, `~`). None when it can't be told.
pub fn word_paths(word: &str, top: &str, layout: &ShellLayout) -> Option<Vec<String>> {
    let mut paths = vec![win32_resolve(top, word)];
    if word.starts_with('~') {
        let home_form = match word.get(1..) {
            None | Some("") => true,
            Some(rest) => rest.starts_with('\\') || rest.starts_with('/'),
        };
        let home = layout.home.as_deref()?;
        if !home_form {
            return None;
        }
        paths.push(win32_join(home, word.get(1..).unwrap_or_default()));
        return Some(paths);
    }
    let msys = msys_paths(word, layout.install.as_deref())?;
    paths.extend(msys);
    Some(paths)
}

/// The Git for Windows installation from `git --exec-path` (`<install>/<arch>/libexec/git-core`).
pub fn git_install(exec_path: &str) -> Option<String> {
    static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?i)^(.*)[\\/](?:[^\\/]+)[\\/]libexec[\\/]git-core[\\/]?$").ok()
    });
    let captures = pattern.as_ref()?.captures(exec_path.trim())?;
    let install = captures
        .get(1)
        .map(|part| part.as_str())
        .unwrap_or_default();
    if install.is_empty() {
        return None;
    }
    Some(paths::win32_normalize(install))
}

#[cfg(test)]
mod tests;
