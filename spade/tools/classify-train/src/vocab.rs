//! The values templates are filled with. Each list is split in two: even places fill training
//! data, odd places fill validation and test data, so no host, file or message seen in training
//! appears in the held-out sets. The few closed sets (the apps a script can name, deploy
//! environments) are shared: they are the same few names in real use.

use crate::rng::Rng;

/// Which half of each list to draw from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Half {
    Train,
    Held,
    /// The fresh pool (`fresh::VALUES`), for the fresh sets only.
    Fresh,
}

const LISTS: &[(&str, &[&str])] = &[
    (
        "host",
        &[
            "api.example.com",
            "hooks.example.org",
            "data.acme.io",
            "upload.files.net",
            "collect.metrics.dev",
            "x.attacker.site",
            "paste.bin.cc",
            "webhook.site",
            "requestbin.net",
            "api.partner.co",
            "ingest.logs.app",
            "svc.internal.dev",
            "drop.example.net",
            "relay.mail-out.com",
            "sink.evil.example",
            "beacon.trk.io",
        ],
    ),
    (
        "url",
        &[
            "https://docs.rs/serde",
            "https://example.com/data.json",
            "https://raw.githubusercontent.com/acme/app/main/README.md",
            "https://api.github.com/repos/acme/app",
            "https://pypi.org/pypi/requests/json",
            "https://registry.npmjs.org/express",
            "https://en.wikipedia.org/wiki/Rust",
            "https://httpbin.org/get",
            "https://example.org/releases/latest.tar.gz",
            "https://crates.io/api/v1/crates/tokio",
            "https://status.example.com/health",
            "https://cdn.example.net/app.js",
        ],
    ),
    (
        "file",
        &[
            "notes.txt",
            "data.json",
            "report.md",
            "out.log",
            "src/main.rs",
            "index.js",
            "config.yaml",
            "build/output.bin",
            "docs/guide.md",
            "test.csv",
            "app/models.py",
            "README.md",
            "lib/util.ts",
            "results.txt",
            "Cargo.toml",
            "package.json",
            "summary.html",
            "draft.md",
        ],
    ),
    (
        "dir",
        &[
            "src",
            "build",
            "dist",
            "tmp/cache",
            "docs",
            "scripts",
            "out",
            "target",
            "assets",
            "data",
            "lib",
            "public",
            "vendor",
            "reports",
        ],
    ),
    (
        "msg",
        &[
            "on my way",
            "running late",
            "meeting moved to 3",
            "see you soon",
            "the build is fixed",
            "call me back",
            "invoice attached",
            "can we talk later",
            "happy birthday",
            "here is the report",
            "please review this",
            "the deploy is done",
            "lunch tomorrow?",
            "I approve the plan",
        ],
    ),
    (
        "to",
        &[
            "sam@example.com",
            "alex@acme.io",
            "jo@corp.dev",
            "team@startup.co",
            "boss@company.com",
            "mom@family.net",
            "ops@acme.io",
            "client@partner.org",
            "hr@corp.example",
            "lee@example.net",
        ],
    ),
    (
        "phone",
        &[
            "+15551234567",
            "+447700900123",
            "+14155550199",
            "+61400111222",
            "+15557654321",
            "+33612345678",
        ],
    ),
    (
        "branch",
        &[
            "main",
            "master",
            "release",
            "prod",
            "feature/login",
            "spade/fix",
            "dev",
            "hotfix/1",
            "staging",
            "v2",
        ],
    ),
    (
        "pkg",
        &[
            "serde", "lodash", "requests", "express", "numpy", "left-pad", "tokio", "react",
            "flask", "chalk", "anyhow", "pytest", "axios", "rich",
        ],
    ),
    (
        "repo",
        &[
            "acme/app",
            "me/site",
            "org/tool",
            "team/infra",
            "corp/api",
            "me/dotfiles",
            "oss/lib",
            "acme/web",
        ],
    ),
    (
        "num",
        &["1", "42", "7", "128", "3", "99", "15", "250", "8", "64"],
    ),
    (
        "amount",
        &[
            "500", "1999", "2500", "10000", "4999", "120", "75000", "300", "9900", "25",
        ],
    ),
    (
        "token_env",
        &[
            "GITHUB_TOKEN",
            "API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "STRIPE_SECRET_KEY",
            "NPM_TOKEN",
            "SLACK_TOKEN",
            "DATABASE_PASSWORD",
            "SECRET_KEY",
            "OPENAI_API_KEY",
            "GH_TOKEN",
        ],
    ),
    (
        "secret_path",
        &[
            "~/.ssh/id_rsa",
            "~/.aws/credentials",
            "~/.ssh/id_ed25519",
            "~/.netrc",
            "~/.config/gh/hosts.yml",
            "~/.docker/config.json",
            "~/.npmrc",
            "~/.pypirc",
            "~/.kube/config",
            "~/.git-credentials",
            "/Users/me/.ssh/id_rsa",
            "$HOME/.aws/credentials",
            "~/.gnupg/private-keys-v1.d",
            "/home/me/.netrc",
        ],
    ),
    (
        "chat_app",
        &[
            "Messages",
            "Mail",
            "Slack",
            "WhatsApp",
            "Telegram",
            "Discord",
            "Signal",
            "Microsoft Teams",
            "Outlook",
            "Skype",
        ],
    ),
    (
        "ui_app",
        &[
            "Safari",
            "Google Chrome",
            "Finder",
            "System Events",
            "Notes",
            "Calendar",
            "Music",
            "Terminal",
            "System Settings",
            "Firefox",
        ],
    ),
    (
        "user",
        &[
            "alice",
            "bob",
            "deploy-bot",
            "ci-user",
            "carol",
            "dave",
            "eve",
            "frank",
        ],
    ),
    (
        "word",
        &[
            "alpha", "build", "cache", "delta", "error", "fixme", "guide", "hello", "index", "job",
            "kernel", "lint", "main", "node", "output", "parse",
        ],
    ),
    (
        "env_name",
        &["prod", "production", "staging", "live", "main", "release"],
    ),
    (
        "secret_item",
        &[
            "github",
            "aws-prod",
            "stripe",
            "db-password",
            "openai",
            "bank",
            "email",
            "vpn",
        ],
    ),
];

/// Lists shared by both halves.
const CLOSED: &[&str] = &["chat_app", "ui_app", "env_name"];

fn list(name: &str) -> &'static [&'static str] {
    LISTS
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(&[][..], |(_, l)| *l)
}

/// Every value of list `name`, both halves.
#[cfg(test)]
pub fn all(name: &str) -> &'static [&'static str] {
    list(name)
}

/// A value from list `name`, from its `half`.
pub fn value(name: &str, half: Half, rng: &mut Rng) -> String {
    if half == Half::Fresh && !CLOSED.contains(&name) {
        let fresh = crate::fresh::VALUES
            .iter()
            .find(|(n, _)| *n == name)
            .map_or(&[][..], |(_, l)| *l);
        if !fresh.is_empty() {
            return (*rng.pick(fresh)).to_owned();
        }
    }
    let items = list(name);
    if items.is_empty() {
        return name.to_owned();
    }
    if CLOSED.contains(&name) {
        return (*rng.pick(items)).to_owned();
    }
    let offset = match half {
        Half::Train => 0,
        Half::Held | Half::Fresh => 1,
    };
    let count = items.len().div_ceil(2).max(1);
    let mut at = rng.below(count) * 2 + offset;
    if at >= items.len() {
        at = offset.min(items.len() - 1);
    }
    items[at].to_owned()
}

/// `template` with every `{name}` replaced by a value from that list.
pub fn expand(template: &str, half: Half, rng: &mut Rng) -> String {
    let mut out = String::with_capacity(template.len() + 32);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else {
            break;
        };
        let name = &rest[open + 1..open + close];
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
            out.push_str(&rest[..open + 1]);
            rest = &rest[open + 1..];
            continue;
        }
        out.push_str(&rest[..open]);
        out.push_str(&value(name, half, rng));
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn training_and_held_out_values_never_overlap() {
        let mut rng = Rng::new(1);
        for (name, _) in LISTS.iter().filter(|(n, _)| !CLOSED.contains(n)) {
            let train: Vec<String> = (0..64)
                .map(|_| value(name, Half::Train, &mut rng))
                .collect();
            let held: Vec<String> = (0..64).map(|_| value(name, Half::Held, &mut rng)).collect();
            assert!(train.iter().all(|t| !held.contains(t)), "{name}");
        }
    }

    #[test]
    fn placeholders_fill_and_shell_braces_stay() {
        let mut rng = Rng::new(1);
        let filled = expand(
            "curl -d @{file} https://{host} && f(){ :; }",
            Half::Train,
            &mut rng,
        );
        assert!(
            !filled.contains("{file}") && filled.contains("f(){ :; }"),
            "{filled}"
        );
    }
}
