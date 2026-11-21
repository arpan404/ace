use serde_json::json;

use super::*;
use crate::effect::Effect;

#[test]
fn a_component_lists_its_tools_and_bad_entries_are_left_out_with_why() {
    let listed = json!([
        { "name": "cheapest", "summary": "Picks the cheapest fare.", "input_schema": { "type": "object", "properties": { "fares": {} } } },
        { "name": "Bad-Name" },
        { "summary": "no name" },
        { "name": "cheapest" },
        { "name": "plain", "extra": true }
    ]);
    let (tools, left_out) = tools_from(&listed.to_string()).unwrap_or_else(|e| panic!("{e}"));
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["cheapest", "plain"]);
    assert_eq!(left_out.len(), 3);
    // A tool with no schema takes any object.
    assert_eq!(tools[1].input_schema, json!({ "type": "object" }));
    assert!(tools_from("{}").is_err());
    assert!(tools_from("not json").is_err());
}

#[test]
fn code_reaches_only_https_hosts_the_package_declares() {
    let hosts = vec![
        "api.example-fares.com".to_owned(),
        "*.cdn.example.com".to_owned(),
    ];
    assert_eq!(
        http_host("https://API.example-fares.com:443/v1?x=1", &hosts),
        Ok("api.example-fares.com".to_owned())
    );
    assert_eq!(
        http_host("https://img.cdn.example.com/a.png", &hosts),
        Ok("img.cdn.example.com".to_owned())
    );
    assert!(http_host("http://api.example-fares.com/", &hosts).is_err());
    assert!(http_host("https://evil.com/", &hosts).is_err());
    assert!(http_host("https://api.example-fares.com.evil.com/", &hosts).is_err());
    assert!(http_host("https://user:pw@api.example-fares.com/", &hosts).is_err());
    assert!(http_host("https://cdn.example.com/", &hosts).is_err());
    let none = http_host("https://api.example-fares.com/", &[]);
    assert!(none.is_err_and(|why| why.contains("declares no network hosts")));
}

#[test]
fn the_hosts_code_reaches_are_those_whose_switch_is_on() {
    let effects = vec![
        Declared {
            effect: Effect::Network,
            hosts: vec!["a.example.com".to_owned()],
            grant: None,
            why: "a".to_owned(),
        },
        Declared {
            effect: Effect::Network,
            hosts: vec!["b.example.com".to_owned()],
            grant: None,
            why: "b".to_owned(),
        },
    ];
    let on = |key: &str| key == "network:hosts:a.example.com";
    assert_eq!(reachable_hosts(&effects, &on), vec!["a.example.com"]);
}

#[test]
fn code_calls_only_spades_own_tools_and_none_the_turn_answers_itself() {
    assert_eq!(call_refusal("memory_search"), None);
    assert_eq!(call_refusal("send_message"), None);
    assert_eq!(call_refusal("workspace_read"), None);
    for barred in [
        "ask_user",
        "shell",
        "call_tool",
        "tool_search",
        "bot_create",
        "task_update",
    ] {
        assert!(call_refusal(barred).is_some(), "{barred}");
    }
    // Not Spade's own: an app's tool, ace's, another component's.
    assert!(call_refusal("gmail_send").is_some());
    assert!(call_refusal("delegate").is_some());
    assert!(call_refusal("browser_click").is_some());
    assert!(call_refusal("code_fares_cheapest").is_some());
}

#[test]
fn a_call_that_gave_no_answer_reads_as_one_line_naming_its_bound() {
    let code = Code {
        name: "fares".to_owned(),
        file: "code/fares.wasm".to_owned(),
        world: crate::package::code::WORLD.to_owned(),
        imports: Vec::new(),
        why: "w".to_owned(),
        timeout_s: 30,
        memory_mb: 128,
    };
    assert_eq!(
        stopped_line(&code, Stop::Deadline),
        "fares stopped: it ran longer than 30 s."
    );
    assert!(stopped_line(&code, Stop::Stopped).contains("not done"));
}

#[test]
fn switch_keys_and_tool_names_read_back() {
    assert_eq!(switch_component(&switch_key("fares")), Some("fares"));
    assert_eq!(switch_component("network:hosts:a.com"), None);
    assert!(is_tool(&tool_name("fares", "cheapest")));
    assert_eq!(tool_name("fares", "cheapest"), "code_fares_cheapest");
}
