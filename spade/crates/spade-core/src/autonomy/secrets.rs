//! Where the person's sign-ins and credentials live, and the tools that read them (ADR 0002,
//! ADR 0144). No level lets a bot reach them. It lists known places and tools, so it misses
//! what it doesn't know: a guard rail in front of the reviewer and the person, not a sandbox.

use serde_json::Value;

/// Paths (lower case, `/`, with `~` for the home folder) where sign-ins, keys and provider
/// credentials live. Matched anywhere inside a word, so any reader (`cat`, `cp`, `base64`,
/// `python -c "open(...)"`) and any quoting is caught.
const PLACES: &[&str] = &[
    "~/.codex",
    "/.codex/auth",
    "~/.claude/",
    "/.claude/.credentials",
    "~/.claude.json",
    "/.claude.json",
    "/.config/gh/hosts",
    "~/.config/gh",
    "~/.aws",
    "/.aws/credentials",
    "/.aws/config",
    "/.ssh/id_",
    "~/.ssh",
    "/.ssh/",
    ".netrc",
    "/.docker/config.json",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "~/.gnupg",
    "/.gnupg/",
    "/library/keychains",
    "login.keychain",
    "/.local/share/keyrings",
    "/.gemini/oauth",
    "~/.gemini",
    "~/.config/opencode",
    "/.local/share/opencode",
    "~/.cursor",
    "~/.config/gcloud",
    "/.config/gcloud/",
    "~/.azure",
    "/.azure/",
    "~/.kube/config",
    "/.kube/config",
    // ace's own sign-ins and the provider homes it manages.
    "/.ace/daemon-token",
    "/.ace/account-homes",
    "/.ace/ace-account.json",
    "/.ace/accounts.sqlite",
    "/.ace/cli-profiles.sqlite",
    "~/.ace/daemon-token",
    "~/.ace/account-homes",
    // Spade's own database and its token beside it.
    "spade.sqlite",
];

/// A word as the matcher reads it: lower case, `\` as `/`, the home folder as `~`.
fn normal(word: &str) -> String {
    word.to_lowercase()
        .replace('\\', "/")
        .replace("${home}", "~")
        .replace("$home", "~")
        .replace("%userprofile%", "~")
}

/// Whether `word` names a place where credentials live.
pub fn names_place(word: &str) -> bool {
    let word = normal(word);
    PLACES.iter().any(|place| word.contains(place))
}

/// Executables whose subcommand (after any flags) reads secrets, with those subcommands; an
/// empty list means every use.
const READERS: &[(&str, &[&str])] = &[
    (
        "security",
        &[
            "find-generic-password",
            "find-internet-password",
            "find-certificate",
            "dump-keychain",
            "export",
            "unlock-keychain",
        ],
    ),
    ("secret-tool", &["lookup", "search"]),
    ("keyring", &["get"]),
    ("kwallet-query", &[]),
    ("pass", &[]),
    ("gopass", &[]),
    ("op", &[]),
    ("bw", &[]),
    ("lpass", &[]),
    ("vault", &["read", "kv", "login", "token"]),
    ("gh", &["auth", "secret", "ssh-key", "gpg-key"]),
    ("docker", &["login"]),
    ("aws", &["configure", "sts"]),
    ("gcloud", &["auth"]),
    ("az", &["account"]),
    ("npm", &["token", "login", "adduser"]),
    ("cargo", &["login", "logout"]),
    ("claude", &["setup-token"]),
    ("codex", &["login", "logout"]),
    (
        "git",
        &["credential", "credential-store", "credential-osxkeychain"],
    ),
];

/// Whether one simple command (its words, executable first) reads secrets: a known reader with
/// a reading subcommand, `gpg --export-secret-*`, or any word naming a credential place.
pub fn command_reads(words: &[String]) -> bool {
    if words.iter().any(|w| names_place(w)) {
        return true;
    }
    let Some((program, rest)) = words.split_first() else {
        return false;
    };
    let program = basename(program);
    if program == "gpg" || program == "gpg2" {
        return rest.iter().any(|w| w.starts_with("--export-secret"));
    }
    let Some((_, subcommands)) = READERS.iter().find(|(name, _)| *name == program) else {
        return false;
    };
    if subcommands.is_empty() {
        return true;
    }
    // The subcommand is the first word that is not a flag (or a flag's value we can't tell
    // apart, so every non-flag word is tried).
    rest.iter()
        .filter(|w| !w.starts_with('-'))
        .any(|w| subcommands.contains(&w.as_str()))
}

pub(super) fn basename(program: &str) -> &str {
    program.rsplit(['/', '\\']).next().unwrap_or(program)
}

/// Whether a call's arguments reach credentials: a string naming a credential place, or one
/// that reads as a command which reads secrets. Every string in the arguments is looked at.
pub fn reaches(arguments: &Value) -> bool {
    let mut strings = Vec::new();
    collect(arguments, &mut strings);
    strings.iter().any(|text| {
        names_place(text)
            || super::shell::simple_commands(text)
                .is_some_and(|commands| commands.iter().any(|words| command_reads(words)))
    })
}

fn collect<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items.iter().for_each(|v| collect(v, out)),
        Value::Object(fields) => fields.iter().for_each(|(key, v)| {
            out.push(key);
            collect(v, out);
        }),
        _ => {}
    }
}
