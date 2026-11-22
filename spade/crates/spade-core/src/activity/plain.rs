//! A tool Spade has no words for, in plain words from its name, and the human target of a call
//! (a page's or a database's title) in place of its raw ids. Pure.

use serde_json::{Map, Value};

/// Verbs a tool's name often starts with: the base, how it reads once done, and while doing.
const VERBS: &[(&str, &str, &str)] = &[
    ("add", "Added", "Adding"),
    ("create", "Created", "Creating"),
    ("delete", "Deleted", "Deleting"),
    ("duplicate", "Duplicated", "Duplicating"),
    ("edit", "Edited", "Editing"),
    ("fetch", "Fetched", "Fetching"),
    ("find", "Found", "Finding"),
    ("get", "Got", "Getting"),
    ("list", "Listed", "Listing"),
    ("move", "Moved", "Moving"),
    ("post", "Posted", "Posting"),
    ("query", "Queried", "Querying"),
    ("read", "Read", "Reading"),
    ("remove", "Removed", "Removing"),
    ("search", "Searched", "Searching"),
    ("send", "Sent", "Sending"),
    ("update", "Updated", "Updating"),
    ("upload", "Uploaded", "Uploading"),
];

/// A tool's name as words, without its server (`notion__notion-create-pages` → "create pages"):
/// an app's tools often repeat the app's name, which the sentence already says.
pub fn words_of(name: &str) -> Vec<String> {
    let (app, last) = name.split_once("__").unwrap_or(("", name));
    let last = last.strip_prefix("ace_").unwrap_or(last);
    let mut words: Vec<String> = last
        .split(['_', '-'])
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    let app = app.to_lowercase();
    if words.len() > 1 && !app.is_empty() && words[0] == app {
        words.remove(0);
    }
    words
}

/// The words for a tool with none of its own: "create pages" / "Creating pages" / "Created
/// pages" when its name starts with a verb, else "use …".
pub fn tool(name: &str) -> (String, String, String) {
    let words = words_of(name);
    if words.is_empty() {
        return (
            format!("use {name}"),
            format!("Using {name}"),
            format!("Used {name}"),
        );
    }
    let rest = words[1..].join(" ");
    let tail = |head: &str| {
        if rest.is_empty() {
            head.to_owned()
        } else {
            format!("{head} {rest}")
        }
    };
    match VERBS.iter().find(|(verb, ..)| *verb == words[0]) {
        Some((verb, done, doing)) => (tail(verb), tail(doing), tail(done)),
        None => {
            let all = words.join(" ");
            (
                format!("use {all}"),
                format!("Using {all}"),
                format!("Used {all}"),
            )
        }
    }
}

/// The app a connector call belongs to, as the sentence names it ("Notion"); none for ace's own
/// tools or a call with no server.
pub fn app_of(name: &str) -> Option<String> {
    let (app, _) = name.split_once("__")?;
    if app.is_empty() || app == "ace" {
        return None;
    }
    let mut chars = app.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
}

/// An id, not words: a field named for one, or a value shaped like one (a UUID, a long hex or
/// token run). Never worth a line.
pub fn id_like(key: &str, value: &Value) -> bool {
    let camel = key.ends_with("Id") || key.ends_with("Ids");
    let key = key.to_lowercase();
    if camel || key == "id" || key == "ids" || key.ends_with("_id") || key.ends_with("_ids") {
        return true;
    }
    let Some(text) = value.as_str() else {
        return false;
    };
    let text = text.trim();
    let token = text.len() >= 16
        && !text.contains(' ')
        && text
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-' || c == '_');
    token && text.chars().filter(char::is_ascii_digit).count() >= 4
}

/// Keys that name what a call acts on, in the order they're trusted.
const TITLES: &[&str] = &["title", "name", "subject"];

/// What a call acts on, by its title, searched a few levels down (a page's `properties.title`
/// inside `pages`); `None` when there is none.
pub fn title_in(fields: &Map<String, Value>, depth: u8) -> Option<String> {
    for key in TITLES {
        if let Some(text) = fields.get(*key).and_then(text_of) {
            return Some(text);
        }
    }
    if depth >= 4 {
        return None;
    }
    fields
        .iter()
        .filter(|(key, value)| !id_like(key, value) && key.as_str() != "parent")
        .find_map(|(_, value)| match value {
            Value::Object(inner) => title_in(inner, depth + 1),
            Value::Array(items) => items
                .iter()
                .filter_map(Value::as_object)
                .find_map(|inner| title_in(inner, depth + 1)),
            _ => None,
        })
}

/// A title's words: text, or rich text as Notion writes it (`[{"text": {"content": …}}]`).
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() && !id_like("", value) => {
            Some(s.trim().to_owned())
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(text_of).collect();
            (!parts.is_empty()).then(|| parts.join(""))
        }
        Value::Object(fields) => ["content", "plain_text", "text", "title"]
            .iter()
            .find_map(|key| fields.get(*key).and_then(text_of)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_apps_tool_reads_by_its_verb_without_repeating_the_app() {
        assert_eq!(
            tool("notion__notion-create-pages"),
            (
                "create pages".to_owned(),
                "Creating pages".to_owned(),
                "Created pages".to_owned()
            )
        );
        assert_eq!(tool("linear__issue_board").2, "Used issue board");
        assert_eq!(
            app_of("notion__notion-create-pages").as_deref(),
            Some("Notion")
        );
        assert_eq!(app_of("ace__screen_act"), None);
    }

    #[test]
    fn a_call_names_its_page_by_title_and_never_by_id() {
        let args = json!({
            "parent": { "data_source_id": "42063c4a-1d2e-4c55-9a1b-0c1d2e3f4a5b" },
            "pages": [{ "properties": { "title": "Launch notes" }, "content": "…" }],
        });
        assert_eq!(
            title_in(args.as_object().expect("object"), 0).as_deref(),
            Some("Launch notes")
        );
        let rich = json!({ "title": [{ "text": { "content": "Roadmap" } }] });
        assert_eq!(
            title_in(rich.as_object().expect("object"), 0).as_deref(),
            Some("Roadmap")
        );
        assert!(id_like("data_source_id", &json!("x")));
        assert!(id_like(
            "parent",
            &json!("42063c4a-1d2e-4c55-9a1b-0c1d2e3f4a5b")
        ));
        assert!(!id_like("query", &json!("weekly notes")));
    }
}
