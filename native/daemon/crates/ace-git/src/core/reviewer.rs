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
use crate::core::error::GitError;
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

/// A path's drive prefix, `C:`, or `""`.
fn drive_of(path: &str) -> &str {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return &path[..2];
    }
    ""
}

fn separator(character: char) -> bool {
    character == '\\' || character == '/'
}

/// Node's `path.win32.normalize`: one drive or UNC prefix, `.` and `..` folded, `\` separators.
fn win32_normalize(path: &str) -> String {
    let (prefix, tail) = if let Some(rest) = path
        .strip_prefix("\\\\")
        .or_else(|| path.strip_prefix("//"))
    {
        let mut parts = rest.split(separator);
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        (
            format!("\\\\{server}\\{share}"),
            parts.collect::<Vec<_>>().join("\\"),
        )
    } else if drive_of(path).is_empty() {
        (String::new(), path.to_owned())
    } else {
        (drive_of(path).to_owned(), path[2..].to_owned())
    };
    let mut folded: Vec<&str> = Vec::new();
    for part in tail.split(separator) {
        match part {
            "" | "." => {}
            ".." => {
                folded.pop();
            }
            other => folded.push(other),
        }
    }
    let mut out = prefix;
    for part in folded {
        if !out.is_empty() && !out.ends_with('\\') {
            out.push('\\');
        }
        out.push_str(part);
    }
    out
}

/// Node's `path.win32.resolve(base, path)`.
fn win32_resolve(base: &str, path: &str) -> String {
    let rooted = path.starts_with('\\') || path.starts_with('/');
    let combined = if !drive_of(path).is_empty() {
        path.to_owned()
    } else if rooted {
        format!("{}{path}", drive_of(base))
    } else if base.is_empty() {
        path.to_owned()
    } else {
        format!("{}\\{path}", base.trim_end_matches(separator))
    };
    win32_normalize(&combined)
}

/// Node's `path.win32.join(base, path)`.
fn win32_join(base: &str, path: &str) -> String {
    if path.is_empty() {
        return win32_normalize(base);
    }
    if base.is_empty() {
        return win32_normalize(path);
    }
    win32_normalize(&format!("{}\\{path}", base.trim_end_matches(separator)))
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
    Some(win32_normalize(install))
}

/// The paths a configured hook command names: every word holding a `/`, quotes removed, read
/// against the working tree root (where Git runs hooks). A bare program name on PATH names none.
pub fn hook_command_paths(command: &str, top: &str) -> Vec<String> {
    command
        .split_whitespace()
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
    match text.strip_suffix('\n') {
        Some(stripped) => stripped.to_owned(),
        None => text,
    }
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
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::core::error::GitErrorCode;

    fn words(command: &str) -> Vec<(String, String, bool)> {
        hook_command_words(command)
            .into_iter()
            .map(|word| (word.shell, word.literal, word.expands))
            .collect()
    }

    fn word(shell: &str, literal: &str, expands: bool) -> (String, String, bool) {
        (shell.to_owned(), literal.to_owned(), expands)
    }

    #[test]
    fn a_hook_command_is_read_as_sh_reads_it_with_backslashes_kept_in_the_literal_word() {
        assert_eq!(
            words(r#""C:\Program Files\Git\bin\sh.exe" -c echo"#),
            vec![
                // Inside double quotes only `$`, backtick, `"`, a backslash and newline are escapes.
                word(
                    r"C:\Program Files\Git\bin\sh.exe",
                    r#"C:\Program Files\Git\bin\sh.exe"#,
                    false
                ),
                word("-c", "-c", false),
                word("echo", "echo", false),
            ]
        );
        assert_eq!(
            words("'a b' \"c d\" ~/hook.sh"),
            vec![
                word("a b", "a b", false),
                word("c d", "c d", false),
                word("~/hook.sh", "~/hook.sh", false),
            ]
        );
        // An empty quoted word exists; operators and blanks separate but never create one.
        // A quote opens a word even when it holds only a blank; the next character joins it.
        assert_eq!(
            words("a;;' '"),
            vec![word("a", "a", false), word(" ", " ", false)]
        );
        assert_eq!(words("''b"), vec![word("b", "b", false)]);
        assert_eq!(words("''"), vec![word("", "", false)]);
        assert_eq!(words(""), Vec::new());
        assert_eq!(words("   "), Vec::new());
    }

    #[test]
    fn a_variable_a_substitution_or_a_glob_expands_but_an_escaped_one_does_not() {
        assert_eq!(
            words("$HOME/hook.sh"),
            vec![word("$HOME/hook.sh", "$HOME/hook.sh", true)]
        );
        assert_eq!(
            words("`which hook`"),
            vec![word("`which", "`which", true), word("hook`", "hook`", true)]
        );
        assert_eq!(
            words("hooks/*.sh"),
            vec![word("hooks/*.sh", "hooks/*.sh", true)]
        );
        assert_eq!(
            words("hooks/?.sh"),
            vec![word("hooks/?.sh", "hooks/?.sh", true)]
        );
        assert_eq!(words("$1"), vec![word("$1", "$1", true)]);
        // A `$` before something that cannot start an expansion stays literal.
        assert_eq!(words("a$/b"), vec![word("a$/b", "a$/b", false)]);
        // Outside quotes a backslash escapes anything; inside double quotes only its own set.
        assert_eq!(words(r"\$HOME"), vec![word("$HOME", r"\$HOME", false)]);
        assert_eq!(words(r#""\$HOME""#), vec![word("$HOME", r"\$HOME", false)]);
        assert_eq!(words(r#""\q""#), vec![word(r"\q", r"\q", false)]);
        // Inside single quotes nothing is special, backslashes included.
        assert_eq!(words(r"'a\$b'"), vec![word(r"a\$b", r"a\$b", false)]);
        // A backslash at the end of the command is the word's last character.
        assert_eq!(words("a\\"), vec![word("a\\", "a\\", false)]);
        // A backslash-newline continues the word, contributing nothing to the shell reading.
        assert_eq!(words("a\\\nb"), vec![word("ab", "a\\\nb", false)]);
    }

    #[test]
    fn an_astral_character_survives_every_quoted_and_unquoted_reading() {
        assert_eq!(
            words("hooks/\u{1F600}.sh '\u{1F600} two' \"\u{1F600}\""),
            vec![
                word("hooks/\u{1F600}.sh", "hooks/\u{1F600}.sh", false),
                word("\u{1F600} two", "\u{1F600} two", false),
                word("\u{1F600}", "\u{1F600}", false),
            ]
        );
    }

    #[test]
    fn a_word_names_a_path_only_when_it_holds_a_separator_or_starts_at_home() {
        for spelling in [r"C:\hooks\a.sh", "hooks/a.sh", "~/a.sh", "/c/a.sh"] {
            assert!(names_path(spelling), "{spelling}");
        }
        for spelling in ["check.sh", "C:check.sh", "a.sh", ""] {
            assert!(!names_path(spelling), "{spelling}");
        }
        assert!(needs_install("/usr/bin/hook.sh"));
        assert!(needs_install("/"));
        assert!(!needs_install("/c/hook.sh"));
        assert!(!needs_install("//host/share/hook.sh"));
        assert!(!needs_install(r"C:\hooks\a.sh"));
    }

    #[test]
    fn an_msys_word_reads_as_its_drive_and_under_the_installation() {
        assert_eq!(
            msys_paths("/c/Users/hook.sh", Some(r"C:\Program Files\Git")),
            Some(vec![
                "c:\\Users\\hook.sh".to_owned(),
                "C:\\Program Files\\Git\\c\\Users\\hook.sh".to_owned(),
            ])
        );
        assert_eq!(
            msys_paths("/cygdrive/d/hooks/a.sh", None),
            Some(vec!["d:\\hooks\\a.sh".to_owned()])
        );
        assert_eq!(
            msys_paths("/bin/hook.sh", Some(r"C:\Program Files\Git")),
            Some(vec!["C:\\Program Files\\Git\\usr\\bin\\hook.sh".to_owned()])
        );
        // /tmp is the user's folder, which is not known here; a UNC path has no MSYS reading.
        assert_eq!(msys_paths("/tmp/hook.sh", Some(r"C:\Git")), None);
        assert_eq!(msys_paths("/tmp/hook.sh", None), None);
        assert_eq!(
            msys_paths("//host/share/hook.sh", Some(r"C:\Git")),
            Some(Vec::new())
        );
        assert_eq!(msys_paths("hooks/a.sh", Some(r"C:\Git")), Some(Vec::new()));
        assert_eq!(msys_paths("/usr/bin/hook.sh", None), None);
    }

    #[test]
    fn a_home_or_installation_word_yields_every_place_it_may_name() {
        let layout = ShellLayout {
            install: Some(r"C:\Program Files\Git".to_owned()),
            home: Some(r"C:\Users\me".to_owned()),
        };
        assert_eq!(
            word_paths("~/hooks/a.sh", r"C:\repo", &layout),
            Some(vec![
                "C:\\repo\\~\\hooks\\a.sh".to_owned(),
                "C:\\Users\\me\\hooks\\a.sh".to_owned(),
            ])
        );
        assert_eq!(
            word_paths("/hooks/a.sh", r"C:\repo", &layout),
            Some(vec![
                "C:\\hooks\\a.sh".to_owned(),
                "C:\\Program Files\\Git\\hooks\\a.sh".to_owned(),
            ])
        );
        // A `~` word needs the home directory; a `~user` word is not a home spelling at all.
        assert_eq!(
            word_paths("~/a.sh", r"C:\repo", &ShellLayout::default()),
            None
        );
        assert_eq!(word_paths("~me/a.sh", r"C:\repo", &layout), None);
        // A rooted word that only the installation can place needs it.
        assert_eq!(
            word_paths("/usr/bin/a.sh", r"C:\repo", &ShellLayout::default()),
            None
        );
    }

    #[test]
    fn the_installation_is_read_from_gits_exec_path() {
        assert_eq!(
            git_install(r"C:\Program Files\Git\mingw64\libexec\git-core").as_deref(),
            Some(r"C:\Program Files\Git")
        );
        assert_eq!(
            git_install("C:/Program Files/Git/cmd/libexec/git-core/").as_deref(),
            Some(r"C:\Program Files\Git")
        );
        assert_eq!(git_install("/usr/libexec/git-core"), None);
        assert_eq!(git_install(""), None);
    }

    #[test]
    fn hook_command_paths_resolve_every_slash_word_against_the_working_tree() {
        assert_eq!(
            hook_command_paths("sh hooks/check.sh /elsewhere/x.sh name", "/repo"),
            vec![
                "/repo/hooks/check.sh".to_owned(),
                "/elsewhere/x.sh".to_owned(),
            ]
        );
        // One leading and one trailing quote come off, as the TypeScript's replace does.
        assert_eq!(
            hook_command_paths("'hooks/a.sh' \"hooks/b.sh\"", "/repo"),
            vec!["/repo/hooks/a.sh".to_owned(), "/repo/hooks/b.sh".to_owned()]
        );
        assert!(hook_command_paths("check.sh", "/repo").is_empty());
    }

    #[tokio::test]
    async fn a_relative_hooks_path_inside_the_checkout_is_the_authors_program() {
        let fixture = Fixture::new("reviewer-hooks");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "core.hooksPath", ".husky"]);
        std::fs::create_dir_all(repo.join(".husky")).expect("hooks dir");
        let query = crate::core::credentials::test_support::ProcessQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[],
        };
        let inside = hooks_inside_checkout(&query, &repo.to_string_lossy())
            .await
            .expect("hooks");
        assert!(inside);
    }

    #[tokio::test]
    async fn the_repositorys_own_git_directory_is_not_the_checkouts_content() {
        let fixture = Fixture::new("reviewer-own-hooks");
        let repo = fixture.repository("repo");
        let query = crate::core::credentials::test_support::ProcessQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[],
        };
        // The default hooks directory sits inside the working tree in a main checkout, but it
        // is the repository's own state, not a file a PR could change.
        let inside = hooks_inside_checkout(&query, &repo.to_string_lossy())
            .await
            .expect("hooks");
        assert!(!inside);
    }

    #[tokio::test]
    async fn a_configured_hook_command_inside_the_working_tree_is_the_authors_program() {
        let fixture = Fixture::new("reviewer-commands");
        let repo = fixture.repository("repo");
        std::fs::create_dir_all(repo.join("hooks")).expect("hooks dir");
        std::fs::write(repo.join("hooks/check.sh"), "#!/bin/sh\nexit 0\n").expect("hook");
        let query = crate::core::credentials::test_support::ProcessQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[],
        };
        fixture.git(&repo, &["config", "hook.ace.command", "sh hooks/check.sh"]);
        assert!(
            hooks_inside_checkout(&query, &repo.to_string_lossy())
                .await
                .expect("hooks")
        );
        // A bare program name is looked up on PATH and names no file of the checkout.
        fixture.git(&repo, &["config", "hook.ace.command", "check.sh"]);
        assert!(
            !hooks_inside_checkout(&query, &repo.to_string_lossy())
                .await
                .expect("hooks")
        );
        // Nor does a file outside the checkout.
        let outside = fixture.root.join("outside.sh");
        std::fs::write(&outside, "#!/bin/sh\n").expect("outside");
        fixture.git(
            &repo,
            &[
                "config",
                "hook.ace.command",
                &format!("sh {}", outside.display()),
            ],
        );
        assert!(
            !hooks_inside_checkout(&query, &repo.to_string_lossy())
                .await
                .expect("hooks")
        );
    }

    #[tokio::test]
    async fn a_hook_file_inside_the_tree_counts_even_when_it_links_out_of_it() {
        let fixture = Fixture::new("reviewer-links");
        let repo = fixture.repository("repo");
        let outside = fixture.root.join("outside.sh");
        std::fs::write(&outside, "#!/bin/sh\n").expect("outside");
        std::os::unix::fs::symlink(&outside, repo.join("link.sh")).expect("symlink");
        fixture.git(&repo, &["config", "hook.ace.command", "sh link.sh"]);
        // `link.sh` holds no `/`, so it names no path at all.
        let query = crate::core::credentials::test_support::ProcessQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[],
        };
        assert!(
            !hooks_inside_checkout(&query, &repo.to_string_lossy())
                .await
                .expect("hooks")
        );
        // Named through a directory the entry is inside the tree; the link's target is the
        // author's own file either way.
        fixture.git(&repo, &["config", "hook.ace.command", "sh ./link.sh"]);
        assert!(
            hooks_inside_checkout(&query, &repo.to_string_lossy())
                .await
                .expect("hooks")
        );
    }

    #[tokio::test]
    async fn an_unresolvable_query_is_the_error_the_caller_sees() {
        // The port's own error is propagated, never turned into "outside the checkout".
        struct Failing;
        impl GitQuery for Failing {
            fn query(
                &self,
                _args: &[String],
            ) -> crate::core::spawn::BoxFuture<'_, Result<ConfigOutput, GitError>> {
                Box::pin(async { Err(GitError::new(GitErrorCode::GitFailed, "query failed")) })
            }
        }
        let result = hooks_inside_checkout(&Failing, "/repo").await;
        assert_eq!(
            result.err().map(|error| error.code),
            Some(GitErrorCode::GitFailed)
        );
    }
}
