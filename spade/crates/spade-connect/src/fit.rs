//! Which catalogue apps fit a need ("what's on my Linear board?", a bot's task), by words alone:
//! the app's name and id, the words its entry lists, and its category's. No model call, so it
//! answers at once and the same way every time. Also what a bot may do with an app, in words, from
//! the catalogue's effects (ADR 0171).

use crate::catalogue::{Category, Entry};

/// Words that point at a category as a whole.
fn category_words(category: Category) -> &'static [&'static str] {
    match category {
        Category::MailChat => &["email", "mail", "inbox", "chat", "message", "messages"],
        Category::Meetings => &[
            "meeting", "meetings", "calendar", "call", "calls", "schedule",
        ],
        Category::Work => &[
            "task", "tasks", "project", "projects", "docs", "notes", "work",
        ],
        Category::Files => &["file", "files", "document", "documents", "folder"],
        Category::SalesSupport => &["crm", "sales", "support", "customer", "customers", "leads"],
        Category::Code => &["code", "deploy", "repo", "developer", "engineering"],
        Category::Data => &["data", "analytics", "metrics", "dashboard", "dashboards"],
        Category::Money => &[
            "payment", "payments", "money", "finance", "invoice", "invoices",
        ],
        Category::Design => &["design", "designs", "website", "site", "brand"],
    }
}

/// Lower-case words of the text, with a plural's `s` also tried ("boards" finds "board").
fn words_of(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    for word in text
        .split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '.'))
        .map(|w| w.trim_matches(|c| c == '-' || c == '.').to_lowercase())
        .filter(|w| w.len() > 1)
    {
        if let Some(single) = word.strip_suffix('s').filter(|w| w.len() > 2) {
            words.push(single.to_owned());
        }
        words.push(word);
    }
    words
}

/// How well `entry` fits the words: its name or id named outright counts most, then a word its
/// entry lists, then its category's.
fn score(entry: &Entry, asked: &[String]) -> u32 {
    let name = entry.name.to_lowercase();
    let names: Vec<String> = words_of(&entry.name);
    let mut score = 0;
    for word in asked {
        if word == &entry.id || word == &name || names.contains(word) {
            score += 20;
        } else if entry.words.iter().any(|w| w == word) {
            score += 3;
        } else if category_words(entry.category).contains(&word.as_str()) {
            score += 1;
        }
    }
    score
}

/// The catalogue apps that fit `need`, best first, at most `most`. An app named outright leads;
/// apps that only share a category word with it are left out when anything fits better.
pub fn fitting<'a>(entries: &'a [Entry], need: &str, most: usize) -> Vec<&'a Entry> {
    let asked = words_of(need);
    let mut scored: Vec<(u32, &Entry)> = entries
        .iter()
        .map(|entry| (score(entry, &asked), entry))
        .filter(|(score, _)| *score > 0)
        .collect();
    let best = scored.iter().map(|(score, _)| *score).max().unwrap_or(0);
    if best > 1 {
        scored.retain(|(score, _)| *score > 1);
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    scored.into_iter().take(most).map(|(_, e)| e).collect()
}

/// What a bot may do in the app once it has it, in a few words each: the account's own reach,
/// then anything the catalogue says its tools do beyond reading and changing data.
pub fn can_do(entry: &Entry) -> Vec<String> {
    let said: Vec<&str> = entry
        .every_tool
        .iter()
        .chain(entry.effects.values())
        .flat_map(|value| match value {
            serde_json::Value::String(word) => vec![word.as_str()],
            serde_json::Value::Array(list) => list.iter().filter_map(|v| v.as_str()).collect(),
            _ => Vec::new(),
        })
        .collect();
    let mut lines = vec![format!(
        "Read and change what your {} account can",
        entry.name
    )];
    for (word, line) in [
        ("send_as_person", "Send in your name"),
        ("pay", "Move money"),
        ("publish", "Publish and deploy"),
        ("change_access", "Change who has access"),
    ] {
        if said.contains(&word) {
            lines.push(line.to_owned());
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalogue::shipped;

    fn ids(need: &str) -> Vec<String> {
        let entries = shipped();
        fitting(&entries, need, 4)
            .into_iter()
            .map(|e| e.id.clone())
            .collect()
    }

    #[test]
    fn an_app_named_in_the_need_comes_first() {
        assert_eq!(
            ids("what's on my Linear board?")
                .first()
                .map(String::as_str),
            Some("linear")
        );
        assert_eq!(
            ids("check Sentry for new errors")
                .first()
                .map(String::as_str),
            Some("sentry")
        );
        assert_eq!(
            ids("my google calendar tomorrow")
                .first()
                .map(String::as_str),
            Some("google-calendar")
        );
    }

    #[test]
    fn a_need_without_an_app_name_finds_apps_by_what_they_are_for() {
        let tickets = ids("triage the bug tickets in our sprint");
        assert!(tickets.contains(&"linear".to_owned()), "{tickets:?}");
        assert!(tickets.contains(&"atlassian".to_owned()), "{tickets:?}");
        let inbox = ids("summarise my inbox every morning");
        assert!(inbox.contains(&"gmail".to_owned()), "{inbox:?}");
        let money = ids("send invoices to customers");
        assert!(money.contains(&"stripe".to_owned()), "{money:?}");
    }

    #[test]
    fn a_need_nothing_fits_finds_nothing() {
        assert!(ids("write a haiku about autumn").is_empty());
        assert!(ids("").is_empty());
    }

    #[test]
    fn what_a_bot_may_do_says_when_an_app_sends_or_pays() {
        let entries = shipped();
        let of = |id: &str| {
            entries
                .iter()
                .find(|e| e.id == id)
                .map(can_do)
                .unwrap_or_default()
        };
        assert_eq!(
            of("linear"),
            ["Read and change what your Linear account can"]
        );
        assert!(
            of("stripe").contains(&"Move money".to_owned()),
            "{:?}",
            of("stripe")
        );
        assert!(
            of("resend").contains(&"Send in your name".to_owned()),
            "{:?}",
            of("resend")
        );
    }
}
