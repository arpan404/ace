use super::*;

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
