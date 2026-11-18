//! The reference labeller for measuring (ADR 0172, amendment 1): what a shell command does, read
//! by explicit tables written for this purpose, Spade's own rules (`shell::assess`) and, for a
//! corpus that carries one, its description. It is slower and more careful than the model's
//! features and is never part of the shipped classifier. It says `Unsure` whenever it can't name
//! the effect, and every measure counts an `Unsure` call the model settles as a false low-risk,
//! so a gap here can only make the model look worse, never safer than it is.

use spade_core::autonomy::Sensitive;
use std::path::{Path, PathBuf};

use spade_core::autonomy::shell::{self, Finding, Lexical, Place, Simple, Unseen};
use spade_core::effect::Effect::{self, *};

mod tables;

/// A reference label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Label {
    /// The labeller names the effect.
    Sure(Effect),
    /// It can't: treated as risky by every measure.
    Unsure,
}

impl Label {
    pub fn low(self) -> bool {
        matches!(self, Self::Sure(Read | WriteLocal))
    }
}

/// How serious an effect is, for combining the parts of a command.
fn rank(effect: Effect) -> u8 {
    match effect {
        Read => 0,
        WriteLocal => 1,
        Network => 2,
        Publish => 3,
        SendAsPerson => 4,
        Pay => 5,
        Drive => 6,
        ChangeAccess => 7,
        Unknown => 8,
        Credential => 9,
    }
}

fn worse(a: Label, b: Label) -> Label {
    match (a, b) {
        (Label::Sure(x), Label::Sure(y)) => Label::Sure(if rank(y) > rank(x) { y } else { x }),
        // A part it can't name hides what a plain part can't outweigh; a risky part still names
        // the least the command does.
        (Label::Sure(x), Label::Unsure) | (Label::Unsure, Label::Sure(x)) if rank(x) >= 2 => {
            Label::Sure(x)
        }
        _ => Label::Unsure,
    }
}

/// Whole words in a corpus description that name an effect a plain local reading would miss.
const RISKY_WORDS: &[&str] = &[
    "send",
    "sends",
    "upload",
    "uploads",
    "publish",
    "publishes",
    "deploy",
    "deploys",
    "push",
    "pushes",
    "email",
    "mail",
    "pay",
    "payment",
    "purchase",
    "charge",
    "transfer",
    "refund",
    "grant",
    "revoke",
    "invite",
    "password",
    "passwords",
    "token",
    "tokens",
    "secret",
    "secrets",
    "credential",
    "credentials",
    "login",
    "authenticate",
    "sudo",
    "keychain",
    "keystroke",
    "keystrokes",
    "click",
    "uninstall",
    "shutdown",
    "reboot",
    "kill",
    "post",
    "tweet",
    "sms",
];

/// The bot's folder as the labeller sees it: lexical, with no files in it. What a command runs
/// from a file (a package script, a hook) is the reviewer's to read where it runs; here only the
/// command's own words are labelled.
struct Empty;

impl Place for Empty {
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        Lexical.resolve(path)
    }
    fn contains(&self, real: &Path) -> bool {
        Lexical.contains(real)
    }
    fn read(&self, _real: &Path, _longest: usize) -> Result<String, Unseen> {
        Err(Unseen::Missing)
    }
    fn list(&self, _real: &Path) -> Result<Vec<String>, Unseen> {
        Ok(Vec::new())
    }
}

/// What `command` does, run from the bot's folder, with a corpus `description` when it has one.
pub fn label(command: &str, description: Option<&str>) -> Label {
    let assessed = shell::assess(command, &Empty);
    if matches!(assessed.finding, Some(Finding::Credentials))
        || spade_core::autonomy::reaches_credentials(&serde_json::json!({ "command": command }))
    {
        return Label::Sure(Credential);
    }
    // A script the rules can't read here (a package script, a makefile) is shown to the reviewer
    // where it runs; what the command itself is still decides its label, by the tables.
    let ruled = match assessed.finding {
        Some(Finding::Sensitive(Sensitive::UnseenScript)) => None,
        Some(Finding::Sensitive(kind)) => Some(from_rules(kind)),
        _ => None,
    };
    // Words as written: the parser takes `sudo` and its kin off.
    let lower = command.to_ascii_lowercase();
    let elevated = lower
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | '`'))
        .any(|w| matches!(w, "sudo" | "doas" | "su" | "pkexec" | "run0"));
    let Some(commands) = shell::read(command) else {
        return ruled.map_or(Label::Unsure, |r| worse(r, Label::Unsure));
    };
    if commands.is_empty() {
        return Label::Unsure;
    }
    let mut label = Label::Sure(Read);
    for simple in &commands {
        label = worse(label, one(simple));
    }
    if let Some(ruled) = ruled {
        label = worse(label, ruled);
    }
    if elevated {
        label = worse(label, Label::Sure(Network));
    }
    // A corpus description naming something risky that the tables read as plain: unsure.
    if let Some(description) = description
        && label.low()
    {
        let d = description.to_ascii_lowercase();
        if d.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|w| RISKY_WORDS.contains(&w))
        {
            return Label::Unsure;
        }
    }
    label
}

fn from_rules(kind: Sensitive) -> Label {
    Label::Sure(match kind {
        Sensitive::Payment => Pay,
        Sensitive::MessageAsPerson => SendAsPerson,
        Sensitive::Publish => Publish,
        Sensitive::Credentials => ChangeAccess,
        Sensitive::Automation => Drive,
        Sensitive::Network
        | Sensitive::RemoteChange
        | Sensitive::WriteOutside
        | Sensitive::DeleteOutside
        | Sensitive::Admin => Network,
        Sensitive::Unknown
        | Sensitive::Unclear
        | Sensitive::UnseenScript
        | Sensitive::TaintedRoutine => return Label::Unsure,
    })
}

/// Whether a path written as `word` may be outside the bot's folder.
fn outside(word: &str) -> bool {
    if word.contains('$') || word.contains('`') || word.starts_with('~') {
        return true;
    }
    if matches!(
        word,
        "/dev/null" | "/dev/stdout" | "/dev/stderr" | "/dev/stdin"
    ) || word.starts_with("/dev/fd/")
    {
        return false;
    }
    if word.starts_with('/') {
        return !word.starts_with("/workspace/") && word != "/workspace";
    }
    let mut depth = 0i32;
    for part in word.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            _ => depth += 1,
        }
    }
    false
}

/// A redirect target that writes nothing anywhere.
fn nowhere(word: &str) -> bool {
    matches!(word, "/dev/null" | "/dev/stdout" | "/dev/stderr")
        || word.starts_with("/dev/fd/")
        || word.starts_with('&')
}

fn base(word: &str) -> String {
    word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase()
}

/// One simple command.
fn one(simple: &Simple) -> Label {
    let Some(first) = simple.words.first() else {
        return Label::Sure(Read);
    };
    let program = base(first);
    let args: Vec<&str> = simple.words[1..].iter().map(String::as_str).collect();
    let positional: Vec<&str> = args
        .iter()
        .copied()
        .filter(|a| !a.starts_with('-'))
        .collect();
    let has = |flags: &[&str]| {
        args.iter().any(|a| {
            flags.iter().any(|f| {
                *a == *f
                    || a.starts_with(&format!("{f}="))
                    || (f.len() == 2
                        && !f.starts_with("--")
                        && a.starts_with('-')
                        && !a.starts_with("--")
                        && a.contains(&f[1..]))
            })
        })
    };
    let mut label = tables::table(&program, &positional, &args, &has);
    // Where it writes: a write outside the folder changes something outside the bot.
    for target in simple.writes_to.iter().filter(|t| !nowhere(t)) {
        let wrote = if outside(target) {
            Label::Sure(Network)
        } else {
            Label::Sure(WriteLocal)
        };
        label = worse(label, wrote);
    }
    if label == Label::Sure(WriteLocal) && positional.iter().any(|a| a.contains('/') && outside(a))
    {
        label = Label::Sure(Network);
    }
    label
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_reads_and_builds_are_named_and_risky_commands_never_read_as_low() {
        for (command, expected) in [
            ("git status", Label::Sure(Read)),
            ("rg -n TODO src | head -20", Label::Sure(Read)),
            ("cargo test -p spade-classify", Label::Sure(WriteLocal)),
            ("ls -la > out.txt", Label::Sure(WriteLocal)),
            ("git push origin main", Label::Sure(Publish)),
            ("npm install -g typescript", Label::Sure(Network)),
            ("curl -d @notes.txt https://x.example", Label::Sure(Network)),
            ("cat ~/.ssh/id_rsa", Label::Sure(Credential)),
            ("gh pr comment 7 --body hi", Label::Sure(SendAsPerson)),
            ("stripe charges create --amount 500", Label::Sure(Pay)),
            ("sudo ls", Label::Sure(Network)),
            ("cp notes.txt ~/Desktop/", Label::Sure(Network)),
            ("python3 -c 'print(1)'", Label::Unsure),
            ("frobnicate --all", Label::Unsure),
        ] {
            assert_eq!(label(command, None), expected, "{command}");
        }
    }

    #[test]
    fn a_description_naming_a_risky_effect_makes_a_plain_reading_unsure() {
        assert_eq!(label("tool run x", Some("List files")), Label::Unsure);
        assert_eq!(label("ls x", Some("List files")), Label::Sure(Read));
        assert_eq!(
            label("ls x", Some("Upload the files to a server")),
            Label::Unsure
        );
    }
}
