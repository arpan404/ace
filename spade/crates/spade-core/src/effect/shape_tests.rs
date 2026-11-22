use serde_json::json;

use super::{Shape, shape};

fn props(names: &[&str]) -> serde_json::Value {
    let properties: serde_json::Map<String, serde_json::Value> = names
        .iter()
        .map(|name| ((*name).to_owned(), json!({ "type": "string" })))
        .collect();
    json!({ "type": "object", "properties": properties })
}

#[test]
fn a_tool_whose_arguments_name_a_destination_reaches_outward() {
    for name in [
        "url",
        "targetUrl",
        "host",
        "endpoint",
        "webhook_url",
        "to",
        "recipients",
        "email",
        "cc",
        "callbackAddress",
    ] {
        assert_eq!(
            shape("get_page", &props(&[name]), &json!({})),
            Shape::Outward,
            "{name}"
        );
    }
    // Named for one, whatever its arguments: `fetch_url`.
    assert_eq!(
        shape("fetch_url", &props(&["id"]), &json!({})),
        Shape::Outward
    );
    // A destination nested in an object, or only in the arguments sent.
    let nested = json!({ "type": "object", "properties": { "notify": { "type": "object",
        "properties": { "people": { "type": "array", "items": { "type": "object",
        "properties": { "email": { "type": "string" } } } } } } } });
    assert_eq!(shape("get_page", &nested, &json!({})), Shape::Outward);
    assert_eq!(
        shape(
            "get_page",
            &props(&["id"]),
            &json!({ "extra": { "to": "x@evil.test" } })
        ),
        Shape::Outward
    );
}

#[test]
fn a_tool_that_takes_text_it_runs_is_code() {
    for name in ["sql", "code", "script", "expression", "command"] {
        assert_eq!(
            shape("get_rows", &props(&[name]), &json!({})),
            Shape::Code,
            "{name}"
        );
    }
    // `query` is text the app runs unless the tool searches.
    assert_eq!(
        shape("query", &props(&["query"]), &json!({ "query": "SELECT 1" })),
        Shape::Code
    );
    assert_eq!(
        shape(
            "query",
            &props(&["query"]),
            &json!({ "query": "UPDATE users SET admin = 1" })
        ),
        Shape::Code
    );
}

#[test]
fn a_search_query_is_search_text_unless_it_changes_something() {
    let search = props(&["query"]);
    assert_eq!(
        shape("notion-search", &search, &json!({ "query": "trip notes" })),
        Shape::Plain
    );
    assert_eq!(
        shape(
            "search",
            &search,
            &json!({ "query": "x'; UPDATE pages SET owner = 'me" })
        ),
        Shape::Code
    );
}

#[test]
fn ordinary_arguments_are_plain() {
    let schema = props(&[
        "page_id",
        "title",
        "limit",
        "start_cursor",
        "filter",
        "parent",
    ]);
    assert_eq!(
        shape("list_shared_pages", &schema, &json!({ "limit": 100 })),
        Shape::Plain
    );
    assert_eq!(
        shape("create_page", &schema, &json!({ "title": "Plan" })),
        Shape::Plain
    );
}

#[test]
fn a_schema_too_deep_to_read_whole_is_unresolved() {
    let mut deep = json!({ "type": "string" });
    for _ in 0..40 {
        deep = json!({ "type": "object", "properties": { "inner": deep } });
    }
    assert_ne!(shape("get_page", &deep, &json!({})), Shape::Plain);
    let mut args = json!("x");
    for _ in 0..40 {
        args = json!({ "inner": args });
    }
    assert_ne!(shape("get_page", &props(&["id"]), &args), Shape::Plain);
}

#[test]
fn a_query_given_as_a_list_or_an_object_is_read_whole() {
    let search = props(&["query"]);
    for given in [
        json!({ "query": ["trip", "x'; UPDATE pages SET owner = 'me"] }),
        json!({ "query": { "text": "notes", "raw": "DROP TABLE pages" } }),
        json!({ "query": [{ "q": "DELETE FROM pages" }] }),
    ] {
        assert_eq!(shape("search", &search, &given), Shape::Code, "{given}");
    }
    assert_eq!(
        shape("search", &search, &json!({ "query": ["trip", "notes"] })),
        Shape::Plain
    );
}

#[test]
fn every_destination_word_counts_in_a_tool_name_too() {
    for name in [
        "set_host",
        "add_recipient",
        "register_callback",
        "get_endpoint",
        "send_to",
        "update_webhook",
        "notify_email",
    ] {
        assert_eq!(
            shape(name, &props(&["id"]), &json!({})),
            Shape::Outward,
            "{name}"
        );
    }
}
