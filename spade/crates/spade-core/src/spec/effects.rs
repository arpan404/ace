//! The `effects` part's regions: the words and their order from `spade_core::effect::Effect`,
//! what a package declares and what stays the person's from `spade_core::effect::ceiling`, and
//! switch keys as the package reader records them.

use serde_json::Value;

use super::conformance;
use super::markdown::{cases, table};
use crate::effect::{self, Effect, ceiling};
use crate::package;

/// What each word means. A match, so a new effect can't be added without a line in the spec.
fn meaning(effect: Effect) -> &'static str {
    match effect {
        Effect::Read => "Only reads.",
        Effect::WriteLocal => {
            "Changes only the bot's own things: its folder, notes, plan, routines and workers."
        }
        Effect::Network => {
            "Changes or reaches something outside the bot: a server, an app's data, another bot."
        }
        Effect::Publish => "Publishes: a release, a package, a deploy, a merge.",
        Effect::SendAsPerson => {
            "Sends something in the person's name: a message, a mail, a comment, a push."
        }
        Effect::Pay => "Spends money.",
        Effect::Drive => {
            "Acts in a page or an app the way the person would: a click, typing, a key."
        }
        Effect::ChangeAccess => "Changes sign-ins, keys or who has access.",
        Effect::Unknown => {
            "A word the runtime doesn't know. It is read as the person's to decide, never as \
             nothing."
        }
        Effect::Credential => "Hands back a secret. A runtime never gives one to a bot.",
    }
}

pub fn regions() -> Vec<(&'static str, String)> {
    vec![
        ("words", words()),
        ("declared", declared()),
        ("keys", keys()),
        ("cases", cases(&conformance::MANIFESTS[1])),
    ]
}

fn words() -> String {
    let rows = Effect::ALL.into_iter().enumerate().map(|(order, effect)| {
        vec![
            (order + 1).to_string(),
            format!("`{}`", effect.name()),
            meaning(effect).to_owned(),
        ]
    });
    table(&["Order", "Word", "What a call with it does"], rows)
}

fn declared() -> String {
    let rows = Effect::ALL.into_iter().map(|effect| {
        let declares = if ceiling::DECLARABLE.contains(&effect) {
            "yes".to_owned()
        } else {
            "no".to_owned()
        };
        let needs = match ceiling::needs(Some(effect)) {
            Some(needed) => format!("`{}`", needed.name()),
            None => "nothing".to_owned(),
        };
        let person = if ceiling::fresh_each_time(Some(effect)) {
            "every call"
        } else {
            "no"
        };
        let granted = match effect::never_granted(Some(effect)) {
            Some(_) => "never",
            None => "yes",
        };
        vec![
            format!("`{}`", effect.name()),
            declares,
            needs,
            person.to_owned(),
            granted.to_owned(),
        ]
    });
    table(
        &[
            "Word",
            "A package may declare it",
            "A call with it needs declared",
            "Goes to the person",
            "A tool with it may be granted",
        ],
        rows,
    )
}

fn keys() -> String {
    let examples = [
        r#"{"effect": "publish"}"#,
        r#"{"effect": "network", "hosts": ["b.example.com", "a.example.com"]}"#,
        r#"{"effect": "network", "grant": {"kind": "drive_site", "host": "example.com"}}"#,
        r#"{"effect": "network", "grant": {"kind": "drive_app", "app": "org.example.notes"}}"#,
        r#"{"effect": "network", "grant": {"kind": "tool", "tool": "web_fetch"}}"#,
    ];
    let suite = conformance::MANIFESTS[0].json();
    table(
        &["Declared (`why` aside)", "Its switch's key"],
        examples.into_iter().map(|json| {
            // Read through the package reader, so the key is the one an install records.
            let mut declared: Value = serde_json::from_str(json).unwrap_or_default();
            declared["why"] = "An example.".into();
            let mut manifest = suite["base"].clone();
            manifest["effects"] = Value::Array(vec![declared]);
            let key = match package::read(&manifest, BUILD) {
                Ok(read) => read.effect_keys().join(", "),
                Err(problems) => format!("refused: {}", problems.join("; ")),
            };
            vec![format!("`{json}`"), format!("`{key}`")]
        }),
    )
}

/// A build new enough for every example.
const BUILD: package::manifest::Build<'static> = package::manifest::Build {
    version: "999.0.0",
    task_chars: 4000,
};
