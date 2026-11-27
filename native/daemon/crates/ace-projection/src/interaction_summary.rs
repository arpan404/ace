// SPDX-License-Identifier: Apache-2.0
//! Interactions as clients get them (ADR 0157), from
//! `packages/projection/src/interaction-summary.ts` and `apps/daemon/src/wire-interactions.ts`.
//!
//! A request too large to send with its thread goes as a summary that says it is one
//! (`truncated`), never cut silently: what identifies the request and every id an answer names
//! stays, each text is cut to a few KiB, and what has no bound of its own (a tool's input, an
//! elicitation's schema, raw payloads) is left out. Storage and the engine keep requests whole;
//! [`summarize_interaction`] copies, [`wire_event`] and [`wire_thread_view`] are what a
//! subscription sends. Views and events are shared, so a summary is made once per event here,
//! not per connection.

use ace_json::{Array, JsString, Map, Value, utf16_len};

/// Requests whose JSON is longer than this (UTF-16 code units) go to clients summarized.
pub const WHOLE_REQUEST_CHARS: usize = 64 * 1024;

const TEXT_CHARS: usize = 2048;
const TITLE_CHARS: usize = 1024;
const LABEL_CHARS: usize = 256;
const MARKDOWN_CHARS: usize = 4096;
const MOST_OPTIONS: usize = 32;
const MOST_WITH_DECLINES: usize = 64;
const MOST_QUESTIONS: usize = 8;
const MOST_ANSWERS: usize = 12;
const ANSWER_CHARS: usize = 128;
const MOST_PATHS: usize = 8;
const MOST_TODOS: usize = 32;
const LONGEST_URL: usize = 8192;
const LONGEST_ID: usize = 1024;
const LONG_DECLINE_IDS: usize = 48 * 1024;
const SUMMARY_CHARS: usize = 60 * 1024;
const LEAST_CHARS: usize = 256;

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

fn object(value: &Value) -> Option<&Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn field_text<'a>(value: &'a Value, key: &str) -> Option<&'a JsString> {
    match field(value, key) {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

fn field_array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match field(value, key) {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn text_or_empty<'a>(value: &'a Value, key: &str) -> &'a JsString {
    field_text(value, key).unwrap_or_else(|| JsString::empty())
}

fn is(value: &Value, key: &str, expected: &str) -> bool {
    field_text(value, key).is_some_and(|seen| seen == expected)
}

fn text(text: &str) -> Value {
    Value::String(JsString::from(text))
}

/// `JSON.stringify(request).length`: the request's JSON in UTF-16 code units.
pub fn request_chars(request: &Value) -> usize {
    utf16_len(&ace_json::to_string(request))
}

/// Whether a client gets `interaction` summarized rather than whole.
pub fn sent_summarized(interaction: &Value) -> bool {
    field(interaction, "truncated").is_some()
        || field(interaction, "request")
            .is_some_and(|request| request_chars(request) > WHOLE_REQUEST_CHARS)
}

/// `interaction` as clients get it: itself when its request is within [`WHOLE_REQUEST_CHARS`]
/// (or it is a summary already), else its summary.
pub fn summarize_interaction(interaction: &Value) -> Value {
    summary(interaction).unwrap_or_else(|| interaction.clone())
}

/// The summary, or `None` when the interaction goes whole.
fn summary(interaction: &Value) -> Option<Value> {
    if field(interaction, "truncated").is_some() {
        return None;
    }
    let request = field(interaction, "request")?;
    let chars = request_chars(request);
    if chars <= WHOLE_REQUEST_CHARS {
        return None;
    }
    let mut out = object(interaction)?.clone();
    out.insert("request", bounded_request(request));
    // `raw` and `truncated` keep or take their place as `{ ...interaction, request, raw, truncated }`.
    out.insert("raw", Value::Array(Array::new()));
    out.insert("truncated", truncated(chars));
    Some(Value::Object(out))
}

fn truncated(chars: usize) -> Value {
    let mut out = Map::with_capacity(1);
    out.insert("chars", Value::Number(ace_json::Number::from(chars as u64)));
    Value::Object(out)
}

/// The summary, or when even that is over `summaryChars` as JSON the least that still names the
/// request and a way to decline it.
fn bounded_request(request: &Value) -> Value {
    let summary = summarize_request(request);
    if utf16_len(&ace_json::to_string(&summary)) <= SUMMARY_CHARS {
        summary
    } else {
        least_request(request)
    }
}

fn least_request(request: &Value) -> Value {
    let kind = field_text(request, "kind").map_or("", JsString::as_str);
    let mut out = Map::with_capacity(4);
    out.insert("kind", text(kind));
    match kind {
        "approval" => {
            out.insert(
                "title",
                Value::String(cut(text_or_empty(request, "title"), LEAST_CHARS)),
            );
            let declined = field_array(request, "options").iter().find(|option| {
                !is_allow(option)
                    && field_text(option, "id").is_some_and(|id| json_chars(id) <= LONG_DECLINE_IDS)
            });
            let options = match declined {
                Some(option) => {
                    let mut kept = Map::with_capacity(3);
                    if let Some(id) = field_text(option, "id") {
                        kept.insert("id", Value::String(id.clone()));
                    }
                    kept.insert(
                        "label",
                        Value::String(cut(text_or_empty(option, "label"), LEAST_CHARS)),
                    );
                    if let Some(kind) = field_text(option, "kind") {
                        kept.insert("kind", Value::String(kind.clone()));
                    }
                    vec![Value::Object(kept)]
                }
                None => Vec::new(),
            };
            out.insert("options", Value::Array(Array::from(options)));
        }
        "question" => {
            out.insert("questions", Value::Array(Array::new()));
        }
        "plan_review" => {
            if let Some(title) = field_text(request, "title") {
                out.insert("title", Value::String(cut(title, LEAST_CHARS)));
            }
            out.insert(
                "markdown",
                Value::String(cut(text_or_empty(request, "markdown"), LEAST_CHARS)),
            );
        }
        "elicitation" => {
            out.insert(
                "server",
                Value::String(cut(text_or_empty(request, "server"), LEAST_CHARS)),
            );
            out.insert(
                "message",
                Value::String(cut(text_or_empty(request, "message"), LEAST_CHARS)),
            );
        }
        "browser_help" => {
            if let Some(tab) = field_text(request, "tabId") {
                out.insert("tabId", Value::String(tab.clone()));
            }
            if let Some(reason) = field_text(request, "reason") {
                out.insert("reason", Value::String(reason.clone()));
            }
            out.insert(
                "message",
                Value::String(cut(text_or_empty(request, "message"), LEAST_CHARS)),
            );
        }
        _ => {}
    }
    Value::Object(out)
}

fn summarize_request(request: &Value) -> Value {
    match field_text(request, "kind").map_or("", JsString::as_str) {
        "approval" => summarize_approval(request),
        "question" => summarize_question(request),
        "plan_review" => summarize_plan_review(request),
        "elicitation" => summarize_elicitation(request),
        "browser_help" => summarize_browser_help(request),
        _ => request.clone(),
    }
}

fn summarize_approval(request: &Value) -> Value {
    let mut out = Map::with_capacity(8);
    out.insert("kind", text("approval"));
    out.insert(
        "title",
        Value::String(cut(text_or_empty(request, "title"), TITLE_CHARS)),
    );
    put_cut(&mut out, request, "description", TEXT_CHARS);
    if let Some(target) = field(request, "target") {
        out.insert("target", summarize_target(target));
    }
    let options: Vec<Value> = kept_options(field_array(request, "options"))
        .into_iter()
        .map(cut_option)
        .collect();
    out.insert("options", Value::Array(Array::from(options)));
    put_copy(&mut out, request, "defaultToNo");
    put_copy(&mut out, request, "suppressAlwaysAllowRule");
    if let Some(server) = field(request, "mcpServer") {
        let mut kept = Map::with_capacity(2);
        kept.insert(
            "name",
            Value::String(cut(text_or_empty(server, "name"), LABEL_CHARS)),
        );
        kept.insert(
            "source",
            Value::String(cut(text_or_empty(server, "source"), LABEL_CHARS)),
        );
        out.insert("mcpServer", Value::Object(kept));
    }
    Value::Object(out)
}

fn summarize_question(request: &Value) -> Value {
    let mut out = Map::with_capacity(3);
    out.insert("kind", text("question"));
    let questions: Vec<Value> = field_array(request, "questions")
        .iter()
        .filter(|question| {
            field_text(question, "id").is_some_and(|id| id.len_utf16() <= LONGEST_ID)
        })
        .take(MOST_QUESTIONS)
        .map(cut_question)
        .collect();
    out.insert("questions", Value::Array(Array::from(questions)));
    if let Some(target) = field(request, "target") {
        out.insert("target", summarize_target(target));
    }
    Value::Object(out)
}

fn summarize_plan_review(request: &Value) -> Value {
    let mut out = Map::with_capacity(6);
    out.insert("kind", text("plan_review"));
    put_cut(&mut out, request, "title", TITLE_CHARS);
    put_cut(&mut out, request, "summary", TEXT_CHARS);
    out.insert(
        "markdown",
        Value::String(cut(text_or_empty(request, "markdown"), MARKDOWN_CHARS)),
    );
    put_cut(&mut out, request, "planPath", TITLE_CHARS);
    if let Some(todos) = field(request, "todos") {
        let todos: Vec<Value> = match todos {
            Value::Array(items) => items.iter().take(MOST_TODOS).map(cut_todo).collect(),
            _ => Vec::new(),
        };
        out.insert("todos", Value::Array(Array::from(todos)));
    }
    Value::Object(out)
}

fn summarize_elicitation(request: &Value) -> Value {
    let mut out = Map::with_capacity(9);
    out.insert("kind", text("elicitation"));
    out.insert(
        "server",
        Value::String(cut(text_or_empty(request, "server"), LABEL_CHARS)),
    );
    out.insert(
        "message",
        Value::String(cut(text_or_empty(request, "message"), TEXT_CHARS)),
    );
    // A cut address leads somewhere else: one too long is left out.
    if let Some(url) = field_text(request, "url")
        && url.len_utf16() <= LONGEST_URL
    {
        out.insert("url", Value::String(url.clone()));
    }
    put_copy(&mut out, request, "mode");
    if let Some(native) = field_text(request, "nativeId")
        && native.len_utf16() <= LONGEST_ID
    {
        out.insert("nativeId", Value::String(native.clone()));
    }
    put_cut(&mut out, request, "title", TITLE_CHARS);
    put_cut(&mut out, request, "description", TEXT_CHARS);
    Value::Object(out)
}

fn summarize_browser_help(request: &Value) -> Value {
    // Bounded by its schema but for its target.
    let Some(target) = field(request, "target") else {
        return request.clone();
    };
    let mut out = object(request).cloned().unwrap_or_else(Map::new);
    out.insert("target", summarize_target(target));
    Value::Object(out)
}

fn summarize_target(target: &Value) -> Value {
    let mut out = Map::with_capacity(9);
    put_copy(&mut out, target, "tool");
    put_copy(&mut out, target, "origin");
    put_copy(&mut out, target, "description");
    put_copy(&mut out, target, "riskClass");
    put_cut(&mut out, target, "command", TEXT_CHARS);
    put_cut(&mut out, target, "cwd", TITLE_CHARS);
    if let Some(paths) = field(target, "paths") {
        let paths: Vec<Value> = match paths {
            Value::Array(items) => items
                .iter()
                .take(MOST_PATHS)
                .map(|path| match path {
                    Value::String(path) => Value::String(cut(path, TITLE_CHARS)),
                    other => other.clone(),
                })
                .collect(),
            _ => Vec::new(),
        };
        out.insert("paths", Value::Array(Array::from(paths)));
    }
    put_copy(&mut out, target, "access");
    Value::Object(out)
}

fn cut_option(option: &Value) -> Value {
    let mut kept = Map::with_capacity(3);
    put_copy(&mut kept, option, "id");
    kept.insert(
        "label",
        Value::String(cut(text_or_empty(option, "label"), LABEL_CHARS)),
    );
    put_copy(&mut kept, option, "kind");
    Value::Object(kept)
}

fn cut_question(question: &Value) -> Value {
    let mut kept = Map::with_capacity(6);
    put_copy(&mut kept, question, "id");
    kept.insert(
        "text",
        Value::String(cut(text_or_empty(question, "text"), TITLE_CHARS)),
    );
    let options: Vec<Value> = field_array(question, "options")
        .iter()
        .filter(|option| field_text(option, "id").is_some_and(|id| id.len_utf16() <= LONGEST_ID))
        .take(MOST_ANSWERS)
        .map(cut_answer)
        .collect();
    kept.insert("options", Value::Array(Array::from(options)));
    put_copy(&mut kept, question, "multiSelect");
    put_copy(&mut kept, question, "allowOther");
    put_copy(&mut kept, question, "secret");
    if let Some(header) = field_text(question, "header") {
        kept.insert("header", Value::String(cut(header, LABEL_CHARS)));
    }
    Value::Object(kept)
}

fn cut_answer(option: &Value) -> Value {
    let mut kept = Map::with_capacity(3);
    put_copy(&mut kept, option, "id");
    kept.insert(
        "label",
        Value::String(cut(text_or_empty(option, "label"), ANSWER_CHARS)),
    );
    if let Some(description) = field_text(option, "description") {
        kept.insert("description", Value::String(cut(description, ANSWER_CHARS)));
    }
    Value::Object(kept)
}

fn cut_todo(todo: &Value) -> Value {
    let mut kept = Map::with_capacity(3);
    kept.insert(
        "content",
        Value::String(cut(text_or_empty(todo, "content"), LABEL_CHARS)),
    );
    put_copy(&mut kept, todo, "status");
    if let Some(id) = field_text(todo, "id") {
        kept.insert("id", Value::String(cut(id, LABEL_CHARS)));
    }
    Value::Object(kept)
}

/// The first `mostOptions` options, then any later declines, in order. An id is never cut, so
/// one longer than `longestId` is left out, but for declines while their long ids come to at
/// most `longDeclineIds` as JSON.
fn kept_options(options: &[Value]) -> Vec<&Value> {
    let mut kept = Vec::new();
    let mut long_ids = 0;
    for (index, option) in options.iter().enumerate() {
        if kept.len() >= MOST_WITH_DECLINES {
            break;
        }
        let declines = !is_allow(option);
        if index >= MOST_OPTIONS && !declines {
            continue;
        }
        let Some(id) = field_text(option, "id") else {
            continue;
        };
        if id.len_utf16() > LONGEST_ID {
            let chars = json_chars(id);
            if !declines || long_ids + chars > LONG_DECLINE_IDS {
                continue;
            }
            long_ids += chars;
        }
        kept.push(option);
    }
    kept
}

fn is_allow(option: &Value) -> bool {
    field_text(option, "kind").is_some_and(|kind| kind.as_str().starts_with("allow"))
}

/// `JSON.stringify(id).length`, in UTF-16 code units.
fn json_chars(id: &JsString) -> usize {
    utf16_len(&ace_json::to_string(&Value::String(id.clone())))
}

/// `put` of `field`'s text cut to `most`, when it is there.
fn put_cut(out: &mut Map, value: &Value, key: &str, most: usize) {
    if let Some(found) = field_text(value, key) {
        out.insert(key, Value::String(cut(found, most)));
    }
}

/// `...{ key: value[key] }`, dropped when the field is absent as `JSON.stringify` drops
/// `undefined`.
fn put_copy(out: &mut Map, value: &Value, key: &str) {
    if let Some(found) = field(value, key) {
        out.insert(key, found.clone());
    }
}

/// `text` within `most` code units, ending in "…" when cut, never splitting a surrogate pair.
fn cut(value: &JsString, most: usize) -> JsString {
    if value.len_utf16() <= most {
        return value.clone();
    }
    let mut end = most.saturating_sub(1);
    if end > 0
        && let Some(last) = value.units().nth(end - 1)
        && (0xd800..=0xdbff).contains(&last)
    {
        end -= 1;
    }
    let mut out = value.slice_units(0, end);
    out.push_js(&JsString::from("…"));
    out
}

/// `event` as clients get it: an `interaction.opened` carries its interaction as sent. `None`
/// when the event goes as it is.
pub fn wire_event(event: &Value) -> Option<Value> {
    let payload = field(event, "payload")?;
    if !is(payload, "type", "interaction.opened") {
        return None;
    }
    let interaction = field(payload, "interaction")?;
    let sent = summary(interaction)?;
    let mut out = object(event)?.clone();
    let mut payload = object(payload)?.clone();
    payload.insert("interaction", sent);
    out.insert("payload", Value::Object(payload));
    Some(Value::Object(out))
}

/// `view` as clients get it: a copy whose too-large requests are summaries, else `None` (the
/// caller keeps `view`, as `wireThreadView` returns it). Weighing comes first, so a view with
/// nothing to summarize copies no interaction.
pub fn wire_thread_view(view: &Value) -> Option<Value> {
    let interactions = field(view, "interactions").and_then(object)?;
    let mut summarized: Vec<Option<Value>> = Vec::with_capacity(interactions.len());
    let mut changed = false;
    for interaction in interactions.values() {
        let sent = summary(interaction);
        changed |= sent.is_some();
        summarized.push(sent);
    }
    if !changed {
        return None;
    }
    let mut rebuilt = Map::with_capacity(interactions.len());
    for ((id, interaction), sent) in interactions.iter().zip(summarized) {
        rebuilt.insert(id.clone(), sent.unwrap_or_else(|| interaction.clone()));
    }
    let mut wired = object(view)?.clone();
    wired.insert("interactions", Value::Object(rebuilt));
    Some(Value::Object(wired))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        ace_json::parse(text).expect("parse")
    }

    #[test]
    fn a_small_request_goes_whole() {
        let interaction = parse(
            r#"{"id":"i","request":{"kind":"approval","title":"Run","options":[],"target":{"tool":"shell","input":{"blob":"kept"}}}}"#,
        );
        assert!(!sent_summarized(&interaction));
        assert_eq!(
            ace_json::to_string(&summarize_interaction(&interaction)),
            ace_json::to_string(&interaction)
        );
    }

    #[test]
    fn a_large_schema_is_left_out_and_the_summary_says_it_is_one() {
        let schema = format!(r#"{{"blob":"{}"}}"#, "x".repeat(70_000));
        let interaction = parse(&format!(
            r#"{{"id":"i","request":{{"kind":"elicitation","server":"s","message":"m","schema":{schema}}},"raw":[{{"type":"x"}}]}}"#
        ));
        assert!(sent_summarized(&interaction));
        let sent = summarize_interaction(&interaction);
        let request = field(&sent, "request").expect("request");
        assert_eq!(field(request, "schema"), None);
        assert_eq!(
            field(&sent, "raw"),
            Some(&Value::Array(Array::new())),
            "raw payloads are left out"
        );
        let chars = field(&sent, "truncated")
            .and_then(|truncated| field(truncated, "chars"))
            .and_then(|chars| match chars {
                Value::Number(chars) => Some(chars.value() as usize),
                _ => None,
            });
        assert_eq!(
            chars,
            Some(request_chars(
                field(&interaction, "request").expect("request")
            ))
        );
    }

    #[test]
    fn an_interaction_already_summarized_is_left_alone() {
        let interaction = parse(
            r#"{"id":"i","request":{"kind":"question","questions":[]},"truncated":{"chars":90000}}"#,
        );
        assert!(sent_summarized(&interaction));
        assert_eq!(
            ace_json::to_string(&summarize_interaction(&interaction)),
            ace_json::to_string(&interaction)
        );
    }

    #[test]
    fn a_cut_never_splits_a_surrogate_pair() {
        let emoji = JsString::from("a😀b");
        assert_eq!(cut(&emoji, 4).as_str(), "a😀b");
        assert_eq!(cut(&emoji, 3).as_str(), "a…");
        assert_eq!(cut(&emoji, 2).as_str(), "a…");
        assert_eq!(cut(&emoji, 1).as_str(), "…");
    }

    #[test]
    fn a_large_event_is_wired_and_a_small_one_is_not() {
        let schema = "x".repeat(70_000);
        let event = parse(&format!(
            r#"{{"seq":1,"id":"e","at":1,"threadId":"t","payload":{{"type":"interaction.opened","interaction":{{"id":"i","request":{{"kind":"elicitation","server":"s","message":"m","schema":{{"blob":"{schema}"}}}}}}}}}}"#
        ));
        let wired = wire_event(&event).expect("wired");
        let interaction = field(&wired, "payload")
            .and_then(|payload| field(payload, "interaction"))
            .expect("interaction");
        assert!(field(interaction, "truncated").is_some());
        let small = parse(
            r#"{"seq":2,"id":"e","at":1,"threadId":"t","payload":{"type":"thread.updated"}}"#,
        );
        assert!(wire_event(&small).is_none());
    }

    #[test]
    fn a_thread_view_rebuilds_only_when_an_interaction_was_summarized() {
        let schema = "x".repeat(70_000);
        let view = parse(&format!(
            r#"{{"kind":"thread","seq":1,"items":{{}},"interactions":{{"a":{{"id":"a","request":{{"kind":"approval","title":"t","options":[]}}}},"b":{{"id":"b","request":{{"kind":"elicitation","server":"s","message":"m","schema":{{"blob":"{schema}"}}}}}}}}}}"#
        ));
        let wired = wire_thread_view(&view).expect("wired");
        let interactions = field(&wired, "interactions")
            .and_then(object)
            .expect("interactions");
        assert!(field(interactions.get("b").expect("b"), "truncated").is_some());
        assert_eq!(field(interactions.get("a").expect("a"), "truncated"), None);
        assert!(wire_thread_view(&view).is_some());
        let whole = parse(
            r#"{"kind":"thread","seq":1,"items":{},"interactions":{"a":{"id":"a","request":{"kind":"question","questions":[]}}}}"#,
        );
        assert!(
            wire_thread_view(&whole).is_none(),
            "an unchanged view is not copied"
        );
    }
}
