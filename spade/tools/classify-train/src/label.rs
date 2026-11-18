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
    // `xargs` runs a program on operands read at run time, which no reading can place.
    if lower
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '('))
        .any(|w| w == "xargs" || w == "parallel")
    {
        label = worse(label, Label::Unsure);
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

/// The alphabetic run of a short token after `-` (`-abc` → "abc", `-o/tmp` → "o", `-k2` → "k"):
/// the characters that could be option letters; the rest is a value. Empty for a long option.
fn short_run(token: &str) -> &str {
    let Some(rest) = token.strip_prefix('-') else {
        return "";
    };
    if rest.starts_with('-') {
        return "";
    }
    let end = rest
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(rest.len());
    &rest[..end]
}

/// The option letters of a short token, read left to right and stopping after the first one in
/// `value_letters` (which consumes the rest of the token as its value): `-to` with `t`
/// value-taking is just `[t]` and `o` is its value, not the `-o` option.
fn short_options(token: &str, value_letters: &str) -> Vec<char> {
    let mut out = Vec::new();
    for c in short_run(token).chars() {
        out.push(c);
        if value_letters.contains(c) {
            break;
        }
    }
    out
}

/// Whether short option `letter` is present as an option (not inside a value) in `args`.
fn short_flag(args: &[&str], letter: char, value_letters: &str) -> bool {
    args.iter()
        .any(|a| short_options(a, value_letters).contains(&letter))
}

/// The value of a short option `letter` that takes one: attached (`-oout` → "out"), or the next
/// argument (`-o out`). `None` when it isn't present as an option.
fn short_value(args: &[&str], letter: char, value_letters: &str) -> Option<String> {
    for (i, a) in args.iter().enumerate() {
        let options = short_options(a, value_letters);
        if options.last() == Some(&letter) {
            let after = &a[1 + short_run(a).len().min(options.len())..];
            if !after.is_empty() {
                return Some(after.to_owned());
            }
            return args.get(i + 1).map(|v| (*v).to_owned());
        }
    }
    None
}

/// The short options that take a value, for the programs whose short options the labeller reads;
/// `""` for any other program, where every letter is read as an option (which only over-labels).
fn value_letters(program: &str) -> &'static str {
    match program {
        "sort" => "oktST",
        "cut" => "dfb",
        "uniq" => "fsw",
        "head" | "tail" => "nc",
        "date" => "dfrs",
        "grep" | "egrep" | "fgrep" | "rg" => "efmABCDd",
        "tr" => "",
        "curl" | "wget" | "http" => "oOuTdFHeAbcm",
        "git" => "COcm",
        _ => "",
    }
}

/// One simple command./// One simple command.
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
        flags.iter().any(|f| {
            if let Some(long) = f.strip_prefix("--") {
                args.iter()
                    .any(|a| *a == *f || a.starts_with(&format!("--{long}=")))
            } else if let Some(letter) = f
                .strip_prefix('-')
                .and_then(|r| (r.len() == 1).then(|| r.chars().next()).flatten())
            {
                // A short option: present as an option letter in a cluster, not inside a value.
                short_flag(&args, letter, value_letters(&program))
            } else {
                args.iter()
                    .any(|a| *a == *f || a.starts_with(&format!("{f}=")))
            }
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
    // A path given as an option's value (`--output=/usr/bin`, `-o/tmp/x`, `-o /tmp/x`), or as a
    // bare operand, that points outside the folder makes a local write an outside one.
    let value_path = |a: &&str| -> Option<String> {
        let value = match a.split_once('=') {
            Some((_, v)) => v.to_owned(),
            None if a.starts_with('-') && !a.starts_with("--") => {
                // `-o/tmp/x`: the part after the option letters.
                let run = short_run(a).len();
                a.get(1 + run..).unwrap_or("").to_owned()
            }
            None => (*a).to_owned(),
        };
        (value.contains('/') && !value.contains(char::is_whitespace)).then_some(value)
    };
    if label == Label::Sure(WriteLocal) && args.iter().filter_map(value_path).any(|p| outside(&p)) {
        label = Label::Sure(Network);
    }
    // A write whose output file is a short option's separate value (`sort -o /out/x`).
    if label == Label::Sure(WriteLocal)
        && ['o', 'O']
            .iter()
            .filter_map(|c| short_value(&args, *c, value_letters(&program)))
            .any(|p| outside(&p))
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
            // Options and scripts that write, run something or change the system.
            ("sort -o out.txt in.txt", Label::Sure(WriteLocal)),
            ("sort -o /tmp/out in.txt", Label::Sure(Network)),
            ("sed 'w out' in.txt", Label::Unsure),
            ("sed 's/a/b/w out' in.txt", Label::Unsure),
            ("sed '1e date' in.txt", Label::Unsure),
            ("sed -n '1,20p' in.txt", Label::Sure(Read)),
            ("awk '{print > \"out\"}' in.txt", Label::Unsure),
            ("awk '{system(\"ls\")}' in.txt", Label::Unsure),
            ("awk -F, '{print $2}' in.csv", Label::Sure(Read)),
            ("find . -fprintf out '%p'", Label::Sure(WriteLocal)),
            ("find . -exec rm {} +", Label::Unsure),
            ("xargs rm < list.txt", Label::Unsure),
            ("git log --output=log.txt", Label::Sure(WriteLocal)),
            ("git grep -O TODO", Label::Unsure),
            ("git difftool", Label::Unsure),
            ("uniq in.txt out.txt", Label::Sure(WriteLocal)),
            ("dd if=a of=/dev/sda", Label::Sure(Network)),
            ("date -s '2020-01-01'", Label::Sure(Network)),
            ("date +%s", Label::Sure(Read)),
            ("less '+!rm x' notes.txt", Label::Unsure),
            ("trap 'rm -rf x' EXIT", Label::Unsure),
            ("python3 -m http.server", Label::Sure(Network)),
            ("npx some-tool", Label::Sure(Network)),
            ("gh browse", Label::Sure(Drive)),
            ("gh pr view 3 --web", Label::Sure(Drive)),
            // Short options: attached values, and a letter inside a value is not a flag.
            ("sort -oout.txt in.txt", Label::Sure(WriteLocal)),
            ("sort -o out.txt in.txt", Label::Sure(WriteLocal)),
            ("sort -o/tmp/evil in.txt", Label::Sure(Network)),
            ("sort -o /tmp/evil in.txt", Label::Sure(Network)),
            ("sort -k2 -t, in.csv", Label::Sure(Read)),
            ("sort -to in.txt", Label::Sure(Read)),
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
