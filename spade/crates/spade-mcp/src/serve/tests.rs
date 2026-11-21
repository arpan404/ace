use serde_json::{Value, json};

use super::*;

const SERVER: Server<'static> = Server {
    name: "spade",
    version: "0.0.0",
    instructions: "Contracts of the person's bots.",
};

fn modern(id: Value, method: &str, mut params: Value) -> Vec<u8> {
    params["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientCapabilities": {},
    });
    serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
        .unwrap_or_default()
}

fn at_modern() -> Headers<'static> {
    Headers {
        version: Some(MODERN),
        ..Headers::default()
    }
}

fn code_of(answer: &Answer) -> Option<i64> {
    answer.1.as_ref()?["error"]["code"].as_i64()
}

fn offer(effects: &[&str]) -> Offer {
    Offer {
        name: "flight_watcher__cheapest_fare".into(),
        title: "Flight watcher: cheapest_fare".into(),
        description: "The cheapest fare seen for a route this week.".into(),
        input: json!({ "type": "object", "properties": {} }),
        output: json!({ "type": "object", "properties": {} }),
        effects: effects.iter().map(|e| (*e).to_owned()).collect(),
    }
}

#[test]
fn a_modern_call_is_read_with_its_key_and_answered_as_complete() {
    let params = json!({ "name": "flight_watcher__cheapest_fare", "arguments": { "from": "KTM" } });
    // The caller's own key rides beside the protocol's fields in `_meta`.
    let mut body: Value =
        serde_json::from_slice(&modern(json!(7), "tools/call", params)).unwrap_or_default();
    body["params"]["_meta"][KEY_META] = json!("k1");
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    let message = read(&bytes, at_modern()).map_err(|a| a.1);
    let Ok(message) = message else {
        panic!("refused: {message:?}");
    };
    assert_eq!(message.era, Era::Modern);
    assert_eq!(
        message.method,
        Method::CallTool {
            name: "flight_watcher__cheapest_fare".into(),
            arguments: json!({ "from": "KTM" }),
            key: Some("k1".into()),
        }
    );
    let (status, body) = called(
        &message,
        SERVER,
        &Called::Returned {
            output: json!({ "fare": 182 }),
            untrusted: true,
        },
    );
    let body = body.unwrap_or_default();
    assert_eq!(status, 200);
    assert_eq!(body["id"], 7);
    assert_eq!(body["result"]["resultType"], "complete");
    assert_eq!(body["result"]["structuredContent"], json!({ "fare": 182 }));
    assert_eq!(body["result"]["content"][0]["text"], r#"{"fare":182}"#);
    assert_eq!(body["result"]["_meta"][UNTRUSTED_META], true);
    assert_eq!(
        body["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "spade"
    );
}

#[test]
fn a_modern_request_needs_the_version_header_to_match_and_a_version_this_server_speaks() {
    let body = modern(json!(1), "tools/list", json!({}));
    let missing = read(&body, Headers::default()).err();
    assert_eq!(missing.as_ref().map(|a| a.0), Some(400));
    assert_eq!(
        missing.as_ref().and_then(code_of),
        Some(code::HEADER_MISMATCH)
    );
    let other = Headers {
        version: Some("2025-11-25"),
        ..Headers::default()
    };
    assert_eq!(
        read(&body, other).err().as_ref().and_then(code_of),
        Some(code::HEADER_MISMATCH)
    );

    let mut future: Value = serde_json::from_slice(&body).unwrap_or_default();
    future["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] = json!("2099-01-01");
    let future = serde_json::to_vec(&future).unwrap_or_default();
    let headers = Headers {
        version: Some("2099-01-01"),
        ..Headers::default()
    };
    let refused = read(&future, headers).err();
    assert_eq!(refused.as_ref().map(|a| a.0), Some(400));
    assert_eq!(
        refused.as_ref().and_then(code_of),
        Some(code::UNSUPPORTED_VERSION)
    );
    let data = refused.and_then(|a| a.1).unwrap_or_default();
    assert_eq!(data["error"]["data"]["supported"][0], MODERN);
    assert_eq!(data["error"]["data"]["requested"], "2099-01-01");
}

#[test]
fn a_mirrored_method_or_name_header_that_disagrees_with_the_body_is_refused() {
    let body = modern(
        json!(1),
        "tools/call",
        json!({ "name": "a__b", "arguments": {} }),
    );
    let wrong_name = Headers {
        version: Some(MODERN),
        method: Some("tools/call"),
        name: Some("c__d"),
    };
    assert_eq!(
        read(&body, wrong_name).err().as_ref().and_then(code_of),
        Some(code::HEADER_MISMATCH)
    );
    let wrong_method = Headers {
        version: Some(MODERN),
        method: Some("tools/list"),
        name: None,
    };
    assert_eq!(
        read(&body, wrong_method).err().as_ref().and_then(code_of),
        Some(code::HEADER_MISMATCH)
    );
}

#[test]
fn a_legacy_client_initializes_at_its_own_version_and_gets_no_result_type() {
    let body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "c", "version": "1" } },
    }))
    .unwrap_or_default();
    let Ok(message) = read(&body, Headers::default()) else {
        panic!("initialize refused");
    };
    assert_eq!(message.era, Era::Legacy);
    let Method::Initialize(asked) = &message.method else {
        panic!("not initialize: {message:?}");
    };
    let body = initialized(&message, SERVER, asked).1.unwrap_or_default();
    assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
    assert!(body["result"].get("resultType").is_none(), "{body}");
    let newer = initialized(&message, SERVER, "2099-01-01")
        .1
        .unwrap_or_default();
    assert_eq!(newer["result"]["protocolVersion"], LEGACY[0]);

    let list = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .unwrap_or_default();
    let legacy = Headers {
        version: Some("2025-06-18"),
        ..Headers::default()
    };
    assert_eq!(read(&list, legacy).map(|m| m.method), Ok(Method::ListTools));
    // A modern version header on a body that names none is a mismatch, not a legacy request.
    assert_eq!(
        read(&list, at_modern()).err().as_ref().and_then(code_of),
        Some(code::HEADER_MISMATCH)
    );
}

#[test]
fn discover_is_modern_only_and_unknown_methods_are_not_found() {
    let discover = modern(json!("d"), "server/discover", json!({}));
    let Ok(message) = read(&discover, at_modern()) else {
        panic!("discover refused");
    };
    let body = discovered(&message, SERVER).1.unwrap_or_default();
    assert_eq!(body["result"]["supportedVersions"][0], MODERN);
    assert_eq!(body["result"]["capabilities"], json!({ "tools": {} }));

    let unknown = read(&modern(json!(2), "prompts/list", json!({})), at_modern()).err();
    assert_eq!(unknown.as_ref().map(|a| a.0), Some(404));
    assert_eq!(
        unknown.as_ref().and_then(code_of),
        Some(code::METHOD_NOT_FOUND)
    );
    let legacy_discover =
        serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": 3, "method": "server/discover" }))
            .unwrap_or_default();
    assert_eq!(
        read(&legacy_discover, Headers::default())
            .err()
            .as_ref()
            .and_then(code_of),
        Some(code::METHOD_NOT_FOUND)
    );
}

#[test]
fn notifications_are_taken_and_a_cancel_names_its_request() {
    let cancel = serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 4 },
    }))
    .unwrap_or_default();
    assert_eq!(
        read(&cancel, Headers::default()).map(|m| m.method),
        Ok(Method::Cancelled(json!(4)))
    );
    let initialized =
        serde_json::to_vec(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .unwrap_or_default();
    assert_eq!(
        read(&initialized, Headers::default()).map(|m| m.method),
        Ok(Method::Notification)
    );
    assert_eq!(accepted(), (202, None));
}

#[test]
fn malformed_messages_are_refused_without_running_anything() {
    for (body, expected) in [
        (&b"{not json"[..], code::PARSE_ERROR),
        (
            br#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#,
            code::INVALID_REQUEST,
        ),
        (
            br#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#,
            code::INVALID_REQUEST,
        ),
        (
            br#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
            code::INVALID_REQUEST,
        ),
        (
            br#"{"jsonrpc":"2.0","id":{"x":1},"method":"ping"}"#,
            code::INVALID_REQUEST,
        ),
        (
            br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}"#,
            code::INVALID_PARAMS,
        ),
    ] {
        let refused = read(body, Headers::default()).err();
        assert_eq!(
            refused.as_ref().and_then(code_of),
            Some(expected),
            "{}",
            String::from_utf8_lossy(body)
        );
    }
}

#[test]
fn a_tools_annotations_come_from_its_contracts_effects_alone() {
    let reads = offer(&[]).to_json();
    assert_eq!(reads["annotations"]["readOnlyHint"], true);
    assert_eq!(reads["annotations"]["openWorldHint"], false);
    assert!(reads["annotations"].get("destructiveHint").is_none());

    let network = offer(&["network", "publish"]).to_json();
    assert!(
        network["annotations"].get("readOnlyHint").is_none(),
        "{network}"
    );
    assert_eq!(network["annotations"]["openWorldHint"], true);
    assert!(network["annotations"].get("destructiveHint").is_none());
    assert_eq!(
        network["_meta"]["dev.acehq.spade/effects"],
        json!(["network", "publish"])
    );
    assert_eq!(
        network["outputSchema"],
        json!({ "type": "object", "properties": {} })
    );
}

#[test]
fn a_failed_call_is_a_tool_error_and_an_unknown_tool_a_protocol_error() {
    let Ok(message) = read(
        &modern(
            json!(5),
            "tools/call",
            json!({ "name": "x__y", "arguments": {} }),
        ),
        at_modern(),
    ) else {
        panic!("refused");
    };
    let failed = called(&message, SERVER, &Called::Failed("It was stopped.".into()))
        .1
        .unwrap_or_default();
    assert_eq!(failed["result"]["isError"], true);
    assert_eq!(failed["result"]["content"][0]["text"], "It was stopped.");
    assert!(failed["result"].get("structuredContent").is_none());
    let unknown = called(&message, SERVER, &Called::NoSuchTool("x__y".into()));
    assert_eq!(code_of(&unknown), Some(code::INVALID_PARAMS));
}

#[test]
fn tool_names_are_the_bots_slug_and_the_contract_within_mcps_characters() {
    for (bot, contract, expected) in [
        (
            "Flight watcher",
            "cheapest_fare",
            "flight_watcher__cheapest_fare",
        ),
        ("  Café & Co!! ", "menu", "caf_co__menu"),
        ("???", "x", "bot__x"),
    ] {
        assert_eq!(tool_name(bot, contract), expected);
    }
    let long = tool_name(&"a".repeat(300), "cheapest_fare");
    assert!(long.len() <= 128, "{}", long.len());
    assert!(long.ends_with("__cheapest_fare"));
}
