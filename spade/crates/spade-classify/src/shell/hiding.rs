//! What a command hides or carries beyond its words (ADR 0172, amendments 1 and 2): a wrapper
//! that runs it with the person's secrets, a variable that makes a program load code, a
//! credential written into it, and the tools it runs whose configuration around the folder
//! could name a program for them to run.

use spade_core::autonomy::ConfigTools;

/// What each program reads configuration as, for [`Found::config`].
pub(super) fn configured(program: &str) -> ConfigTools {
    ConfigTools::of(program)
}

pub(super) fn union(a: ConfigTools, b: ConfigTools) -> ConfigTools {
    a.union(b)
}

/// Environment variables that make a program load code or read other configuration (a search
/// path, a preload, a pager, an editor, a config file): a command that sets one hides what it
/// runs. Matched by name, lower-cased; the prefixes below match a whole family.
pub(super) const LOADS_CODE: &[&str] = &[
    "path",
    "pythonpath",
    "pythonstartup",
    "pythonhome",
    "pythonuserbase",
    "node_options",
    "node_path",
    "ld_preload",
    "ld_library_path",
    "ld_audit",
    "bash_env",
    "env",
    "zdotdir",
    "perl5opt",
    "perl5lib",
    "perllib",
    "rubyopt",
    "rubylib",
    "lessopen",
    "lessclose",
    "lesskey",
    "pager",
    "manpager",
    "editor",
    "visual",
    "browser",
    "ripgrep_config_path",
    "rustc",
    "rustc_wrapper",
    "rustc_workspace_wrapper",
    "rustdoc",
    "rustflags",
    "rustup_toolchain",
    "prompt_command",
    "ifs",
    "shellopts",
    "bashopts",
    "histfile",
    "inputrc",
    "terminfo",
];
pub(super) const LOADS_CODE_PREFIXES: &[&str] = &[
    "git_",
    "cargo_",
    "npm_config_",
    "yarn_",
    "bun_",
    "pnpm_",
    "dyld_",
    "ld_",
    "python",
    "node_",
    "rustup_",
    "mise_",
    "rtx_",
    "direnv_",
];

/// Prefixes of the access tokens and keys services issue: a command carrying one uses a
/// credential, whatever it does with it.
pub(super) const TOKEN_PREFIXES: &[&str] = &[
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "sk_live_",
    "sk_test_",
    "rk_live_",
    "pk_live_",
    "sk-",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxs-",
    "akia",
    "asia",
    "aiza",
    "ya29.",
    "npm_",
    "pypi-",
    "hf_",
    "dop_v1_",
    "shpat_",
    "sq0atp-",
    "ssh-rsa aaaa",
    "ssh-ed25519 aaaa",
    "-----begin",
];

/// Whether `text` (as written) carries a credential: a URL with a password in it
/// (`https://user:secret@host`), or a string shaped like an issued token or key.
pub(crate) fn carries_credential(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let in_url = lower.split("://").skip(1).any(|rest| {
        let authority = rest
            .split(['/', '?', '#', ' ', '\'', '"'])
            .next()
            .unwrap_or("");
        authority
            .rsplit_once('@')
            .is_some_and(|(userinfo, _)| userinfo.contains(':'))
    });
    in_url
        || lower
            .split(|c: char| {
                c.is_whitespace() || matches!(c, '\'' | '"' | '=' | ':' | '@' | '/' | ',')
            })
            .any(|word| {
                TOKEN_PREFIXES.iter().any(|prefix| {
                    word.starts_with(prefix)
                        && word.len() >= prefix.len() + 12
                        && word[prefix.len()..]
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                })
            })
        || lower.contains("-----begin") && lower.contains("private key")
}

/// Whether `lower` sets, anywhere, a variable that makes a program load code.
pub(super) fn sets_loader(lower: &str) -> bool {
    lower
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '|' | '&' | '(' | ')' | '`'))
        .filter_map(|word| word.split_once('='))
        .any(|(name, _)| {
            let name = name.trim_start_matches(['"', '\'']);
            !name.is_empty()
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && (LOADS_CODE.contains(&name)
                    || LOADS_CODE_PREFIXES.iter().any(|p| name.starts_with(p)))
        })
}

/// Programs that run a command with the person's secrets put into its environment (`doppler run
/// -- ls`, `op run -- …`, `aws-vault exec prod -- …`): the command they wrap is what the parser
/// shows, but it runs with the person's sign-ins, so the whole is never settled.
pub(super) const SECRET_RUNNERS: &[&str] = &[
    "doppler",
    "aws-vault",
    "infisical",
    "chamber",
    "envchain",
    "teller",
    "dotenvx",
    "berglas",
    "varlock",
    "summon",
    "with-secrets",
];

/// Of programs with other uses, the subcommands that do the same (`op run`, `sops exec-env`).
pub(super) const SECRET_SUBCOMMANDS: &[(&str, &str)] = &[
    ("op", "run"),
    ("sops", "exec-env"),
    ("sops", "exec-file"),
    ("vault", "exec"),
    ("gopass", "env"),
    ("pass", "env"),
];

/// Whether `lower` starts a command, anywhere in it, with a program that injects the person's
/// secrets. Read from the words as written, since the parser takes such wrappers off.
pub(super) fn runs_with_secrets(lower: &str) -> bool {
    lower
        .split(['\n', ';', '|', '&', '(', ')', '`', '{', '}'])
        .any(|segment| {
            let mut words = segment.split_whitespace().skip_while(|w| {
                w.contains('=')
                    || matches!(
                        *w,
                        "sudo"
                            | "env"
                            | "exec"
                            | "command"
                            | "nohup"
                            | "time"
                            | "then"
                            | "do"
                            | "!"
                    )
            });
            let Some(first) = words.next() else {
                return false;
            };
            let first = first.rsplit('/').next().unwrap_or(first);
            let next = words.find(|w| !w.starts_with('-')).unwrap_or("");
            SECRET_RUNNERS.contains(&first) || SECRET_SUBCOMMANDS.contains(&(first, next))
        })
}
