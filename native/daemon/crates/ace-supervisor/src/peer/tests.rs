// SPDX-License-Identifier: Apache-2.0
//! The JSON-RPC peer's input/output tables: limits, ids, null cases and the
//! shared writer's ordering.

use super::*;

fn new_peer() -> RpcPeer {
    RpcPeer::new(PeerConfig::default())
}

fn object(entries: &[(&str, Value)]) -> Value {
    Value::from(
        entries
            .iter()
            .map(|(key, value)| (JsString::from(*key), value.clone()))
            .collect::<Vec<_>>(),
    )
}

fn call(
    peer: &mut RpcPeer,
    method: &str,
    params: Option<&Value>,
    id: u64,
    timeout: Timeout,
) -> Vec<PeerEffect> {
    match peer.request(method, params, id, timeout) {
        Ok(effects) => effects,
        Err(error) => panic!("request refused: {error}"),
    }
}

fn order(effects: &[PeerEffect]) -> Vec<String> {
    effects
        .iter()
        .map(|effect| match effect {
            PeerEffect::Frame { dir, .. } => match dir {
                Direction::Send => "frame:send".to_owned(),
                Direction::Recv => "frame:recv".to_owned(),
            },
            PeerEffect::Write { ticket, .. } => format!("write:{ticket}"),
            PeerEffect::Settle { id, .. } => format!("settle:{id}"),
            PeerEffect::ServerRequest { id, .. } => {
                format!("server:{}", jsonrpc::id_to_json(id))
            }
            PeerEffect::Notification { method, .. } => {
                format!("notify:{}", method.as_str())
            }
            PeerEffect::Malformed { .. } => "malformed".to_owned(),
            PeerEffect::ArmTimer { key, .. } => format!("arm:{key}"),
            PeerEffect::CancelTimer { key } => format!("cancel:{key}"),
            PeerEffect::Failed { .. } => "failed".to_owned(),
        })
        .collect()
}

fn frames(effects: &[PeerEffect]) -> Vec<(Direction, String)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            PeerEffect::Frame { dir, value, .. } => Some((*dir, value.to_json())),
            _ => None,
        })
        .collect()
}

/// The text each frame carries, when the peer was asked for it (`PeerConfig::frame_text`).
fn frame_texts(effects: &[PeerEffect]) -> Vec<(Direction, String, Option<String>)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            PeerEffect::Frame { dir, value, text } => Some((*dir, value.to_json(), text.clone())),
            _ => None,
        })
        .collect()
}

fn writes(effects: &[PeerEffect]) -> Vec<(u64, String)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            PeerEffect::Write { wire, ticket } => {
                Some((*ticket, String::from_utf8_lossy(wire).trim_end().to_owned()))
            }
            _ => None,
        })
        .collect()
}

fn settles(effects: &[PeerEffect]) -> Vec<(u64, Result<String, String>)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            PeerEffect::Settle { id, result } => Some((
                *id,
                match result {
                    Ok(value) => Ok(value.to_json()),
                    Err(error) => Err(error.message().to_owned()),
                },
            )),
            _ => None,
        })
        .collect()
}

fn server_id(effects: &[PeerEffect]) -> RpcId {
    match effects.iter().find_map(|effect| match effect {
        PeerEffect::ServerRequest { id, .. } => Some(id.clone()),
        _ => None,
    }) {
        Some(id) => id,
        None => panic!("no server request"),
    }
}

#[test]
fn a_request_writes_javascripts_exact_line_after_its_frame() {
    let mut peer = new_peer();
    let params = object(&[("threadId", Value::from("t"))]);
    let effects = call(
        &mut peer,
        "thread/read",
        Some(&params),
        7,
        Timeout::After(1_000.0),
    );
    assert_eq!(
        order(&effects),
        vec!["arm:request:1", "frame:send", "write:0"]
    );
    assert_eq!(
        writes(&effects),
        vec![(
            0,
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/read","params":{"threadId":"t"}}"#
                .to_owned()
        )]
    );
}

#[test]
fn a_peer_asked_for_frame_text_carries_the_line_it_read_and_wrote() {
    let mut peer = RpcPeer::new(PeerConfig {
        frame_text: true,
        ..PeerConfig::default()
    });
    // The agent's own spelling of a line whose duplicate key `JSON.parse` collapses.
    let line = r#"{ "jsonrpc": "2.0", "id": 1, "result": { "a": 1, "a": 2 } }"#;
    let effects = peer.line(line);
    assert_eq!(
        frame_texts(&effects),
        vec![(
            Direction::Recv,
            r#"{"jsonrpc":"2.0","id":1,"result":{"a":2}}"#.to_owned(),
            Some(line.to_owned())
        )]
    );
    // A sent frame carries the very line the pipe got, minus its newline.
    let sent = call(&mut peer, "x", None, 2, Timeout::Disabled);
    let (_, tree, text) = frame_texts(&sent).remove(0);
    let written = writes(&sent);
    assert_eq!(written.len(), 1);
    let wire = written[0].1.clone();
    assert_eq!(text, Some(wire.clone()));
    assert_eq!(tree, wire);
}

#[test]
fn a_peer_that_reads_the_tree_only_carries_no_frame_text() {
    let mut peer = new_peer();
    let effects = peer.line(r#"{"jsonrpc":"2.0","method":"thread/started","params":{}}"#);
    assert!(
        frame_texts(&effects)
            .iter()
            .all(|(_, _, text)| text.is_none())
    );
    let sent = call(&mut peer, "x", None, 1, Timeout::Disabled);
    assert!(frame_texts(&sent).iter().all(|(_, _, text)| text.is_none()));
}

#[test]
fn a_response_settles_its_call_once_and_keeps_unknown_fields() {
    let mut peer = new_peer();
    call(&mut peer, "thread/read", None, 7, Timeout::After(1_000.0));
    let line = r#"{"id":1,"result":{"ok":true},"extra":{"x":1}}"#;
    let effects = peer.line(line);
    assert_eq!(
        order(&effects),
        vec!["frame:recv", "cancel:request:1", "settle:7"]
    );
    assert_eq!(frames(&effects), vec![(Direction::Recv, line.to_owned())]);
    assert_eq!(
        settles(&effects),
        vec![(7, Ok(r#"{"ok":true}"#.to_owned()))]
    );

    let again = peer.line(line);
    assert_eq!(order(&again), vec!["frame:recv"]);
    assert!(settles(&again).is_empty());
}

#[test]
fn an_error_response_settles_with_its_json_text() {
    let mut peer = new_peer();
    call(&mut peer, "x", None, 4, Timeout::Disabled);
    let effects = peer.line(r#"{"id":1,"error":{"code":-32000,"message":"boom"}}"#);
    assert_eq!(order(&effects), vec!["frame:recv", "settle:4"]);
    assert_eq!(
        settles(&effects),
        vec![(4, Err(r#"{"code":-32000,"message":"boom"}"#.to_owned()))]
    );
}

#[test]
fn a_server_answer_keeps_the_id_type_and_lone_surrogates() {
    let cases = [
        ("7", "7"),
        (r#""7""#, r#""7""#),
        ("-0", "0"),
        (r#""a\ud800""#, r#""a\ud800""#),
    ];
    for (input, expected) in cases {
        let mut peer = new_peer();
        let line = format!(r#"{{"jsonrpc":"2.0","id":{input},"method":"x"}}"#);
        let effects = peer.line(&line);
        let id = server_id(&effects);
        let answered = peer.answer(&id, &Value::Null);
        assert_eq!(order(&answered), vec!["frame:send", "write:0"]);
        let expected = format!(r#"{{"jsonrpc":"2.0","id":{expected},"result":null}}"#);
        assert_eq!(writes(&answered), vec![(0, expected)]);
    }
}

#[test]
fn unknown_methods_and_fields_are_kept_raw() {
    let mut peer = new_peer();
    let note = r#"{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"t"},"zeta":1},"extra":{"kept":[1,2]}}"#;
    let effects = peer.line(note);
    assert_eq!(order(&effects), vec!["frame:recv", "notify:thread/started"]);
    assert_eq!(frames(&effects), vec![(Direction::Recv, note.to_owned())]);
    match &effects[1] {
        // The params stay in the frame effect alone, not in a second copy.
        PeerEffect::Notification { method } => assert_eq!(method.as_str(), "thread/started"),
        _ => panic!("expected a notification"),
    }

    let request = r#"{"id":"s1","method":"future/method","params":{"a":1},"future":{"b":2}}"#;
    let effects = peer.line(request);
    assert_eq!(order(&effects), vec!["frame:recv", "server:\"s1\""]);
    assert_eq!(
        frames(&effects),
        vec![(Direction::Recv, request.to_owned())]
    );
    match &effects[1] {
        PeerEffect::ServerRequest { method, params, .. } => {
            assert_eq!(method.as_str(), "future/method");
            assert_eq!(
                params.as_ref().map(Value::to_json).as_deref(),
                Some(r#"{"a":1}"#)
            );
        }
        _ => panic!("expected a server request"),
    }
}

#[test]
fn absent_params_and_explicit_null_are_different() {
    let cases = [
        (
            None,
            r#"{"jsonrpc":"2.0","id":1,"method":"ready"}"#.to_owned(),
        ),
        (
            Some(Value::Null),
            r#"{"jsonrpc":"2.0","id":1,"method":"ready","params":null}"#.to_owned(),
        ),
    ];
    for (params, expected) in cases {
        let mut peer = new_peer();
        let effects = call(&mut peer, "ready", params.as_ref(), 1, Timeout::Disabled);
        assert_eq!(order(&effects), vec!["frame:send", "write:0"]);
        assert_eq!(writes(&effects), vec![(0, expected)]);
    }

    let mut peer = new_peer();
    let effects = peer.line(r#"{"id":"s2","method":"no/params"}"#);
    match &effects[1] {
        PeerEffect::ServerRequest { params, .. } => assert!(params.is_none()),
        _ => panic!("expected a server request"),
    }
}

#[test]
fn unparsable_and_non_envelope_lines_are_malformed_never_fatal() {
    for (line, expected_frames) in [
        ("not json", 0),
        ("[1,2]", 1),
        (r#"{"id":1}"#, 1),
        (r#"{"id":1,"method":2}"#, 1),
    ] {
        let mut peer = new_peer();
        let effects = peer.line(line);
        assert_eq!(frames(&effects).len(), expected_frames, "{line}");
        assert!(matches!(
            effects.last(),
            Some(PeerEffect::Malformed { line: kept }) if kept == line
        ));
        assert!(peer.request("x", None, 1, Timeout::Disabled).is_ok());
    }
}

#[test]
fn a_timeout_settles_once_with_jsonrpc_ts_message() {
    let mut peer = new_peer();
    let effects = call(&mut peer, "slow", None, 3, Timeout::After(5.0));
    assert_eq!(
        order(&effects),
        vec!["arm:request:1", "frame:send", "write:0"]
    );
    let key = match &effects[0] {
        PeerEffect::ArmTimer { key, .. } => key.clone(),
        other => panic!("expected a timer, got {other:?}"),
    };
    let timed = peer.timer(&key);
    assert_eq!(
        settles(&timed),
        vec![(3, Err("JSON-RPC request timed out: slow".to_owned()))]
    );
    assert!(peer.timer(&key).is_empty());
    let late = peer.line(r#"{"id":1,"result":1}"#);
    assert_eq!(order(&late), vec!["frame:recv"]);
}

#[test]
fn the_pending_bound_refuses_before_reserving_a_write() {
    let mut peer = RpcPeer::new(PeerConfig {
        max_pending: 1,
        ..PeerConfig::default()
    });
    call(&mut peer, "first", None, 1, Timeout::Disabled);
    match peer.request("second", None, 2, Timeout::Disabled) {
        Err(error) => assert_eq!(error.message(), "JSON-RPC pending request limit"),
        Ok(_) => panic!("the second request was admitted"),
    }
    let settled = peer.line(r#"{"id":1,"result":null}"#);
    assert_eq!(settles(&settled).len(), 1);
    call(&mut peer, "second", None, 2, Timeout::Disabled);
}

#[test]
fn a_rejected_reply_settles_only_that_call() {
    let mut peer = new_peer();
    call(&mut peer, "one", None, 10, Timeout::Disabled);
    call(&mut peer, "two", None, 11, Timeout::Disabled);
    let rejected = peer.reject_request(&RpcId::Number(1.0), PeerError::new("JSON-RPC reply lost"));
    assert_eq!(order(&rejected), vec!["settle:10"]);
    let other = peer.line(r#"{"id":2,"result":"kept"}"#);
    assert_eq!(order(&other), vec!["frame:recv", "settle:11"]);
    assert!(
        peer.reject_request(&RpcId::Number(1.0), PeerError::new("again"))
            .is_empty()
    );
}

#[test]
fn a_settled_call_withdraws_its_queued_write() {
    let mut peer = new_peer();
    call(&mut peer, "one", None, 1, Timeout::Disabled);
    let armed = call(&mut peer, "two", None, 2, Timeout::After(5.0));
    let key = match &armed[0] {
        PeerEffect::ArmTimer { key, .. } => key.clone(),
        other => panic!("expected a timer, got {other:?}"),
    };
    let timed = peer.timer(&key);
    assert_eq!(order(&timed), vec!["cancel:request:2", "settle:2"]);
    assert_eq!(
        settles(&timed),
        vec![(2, Err("JSON-RPC request timed out: two".to_owned()))]
    );
    assert!(writes(&peer.written(0)).is_empty());
}

#[test]
fn a_disabled_call_ignores_a_timer_key() {
    let mut peer = new_peer();
    call(&mut peer, "free", None, 1, Timeout::Disabled);
    assert!(peer.timer("request:1").is_empty());
    let reply = peer.line(r#"{"id":1,"result":null}"#);
    assert_eq!(order(&reply), vec!["frame:recv", "settle:1"]);
}

#[test]
fn stop_requests_keeps_observing_final_frames() {
    let mut peer = new_peer();
    call(&mut peer, "mine", None, 1, Timeout::After(1_000.0));
    let stopped = peer.stop_requests("process exited");
    assert_eq!(order(&stopped), vec!["cancel:request:1", "settle:1"]);
    let note = peer.line(r#"{"method":"final","params":{"x":1}}"#);
    assert_eq!(order(&note), vec!["frame:recv", "notify:final"]);
    assert_eq!(
        order(&peer.line(r#"{"id":9,"method":"still"}"#)),
        vec!["frame:recv"]
    );
    match peer.request("after", None, 2, Timeout::Disabled) {
        Err(error) => assert_eq!(error.message(), "process exited"),
        Ok(_) => panic!("a stopped peer admitted a request"),
    }
    assert!(peer.close("process exited").is_empty());
    assert!(peer.line(r#"{"method":"too/late"}"#).is_empty());
}

#[test]
fn close_settles_every_pending_call_once_and_refuses_later_input() {
    let mut peer = new_peer();
    call(&mut peer, "one", None, 1, Timeout::After(1_000.0));
    call(&mut peer, "two", None, 2, Timeout::After(1_000.0));
    let closed = peer.close("process exited");
    assert_eq!(
        order(&closed),
        vec![
            "cancel:request:1",
            "settle:1",
            "cancel:request:2",
            "settle:2"
        ]
    );
    assert!(peer.close("again").is_empty());
    assert!(peer.line(r#"{"id":1,"result":1}"#).is_empty());
    match peer.request("after", None, 3, Timeout::Disabled) {
        Err(error) => assert_eq!(error.message(), "process exited"),
        Ok(_) => panic!("a closed peer admitted a request"),
    }
}

#[test]
fn an_incoming_slot_is_held_until_the_reply_is_written() {
    let config = PeerConfig {
        max_incoming: 1,
        ..PeerConfig::default()
    };
    let mut held = RpcPeer::new(PeerConfig {
        max_incoming: 1,
        ..PeerConfig::default()
    });
    let first = held.line(r#"{"id":1,"method":"server"}"#);
    held.answer_error(&server_id(&first), INTERNAL_ERROR, "boom");
    let over = held.line(r#"{"id":2,"method":"server"}"#);
    assert_eq!(order(&over), vec!["frame:recv", "failed"]);
    assert!(matches!(
        over.last(),
        Some(PeerEffect::Failed { message }) if message == "JSON-RPC incoming request limit"
    ));

    let mut released = RpcPeer::new(config);
    let first = released.line(r#"{"id":1,"method":"server"}"#);
    released.answer(&server_id(&first), &Value::Null);
    released.written(0);
    let next = released.line(r#"{"id":2,"method":"server"}"#);
    assert_eq!(order(&next), vec!["frame:recv", "server:2"]);
}

#[test]
fn method_not_found_answers_with_jsonrpc_ts_strings() {
    let mut peer = new_peer();
    let request = peer.line(r#"{"id":"s9","method":"missing","params":{}}"#);
    let id = server_id(&request);
    let answered = peer.answer_not_found(&id);
    assert_eq!(order(&answered), vec!["frame:send", "write:0"]);
    assert_eq!(
        writes(&answered),
        vec![(
            0,
            r#"{"jsonrpc":"2.0","id":"s9","error":{"code":-32601,"message":"unhandled request"}}"#
                .to_owned()
        )]
    );
}

#[test]
fn an_oversized_message_settles_with_the_message_limit() {
    let mut peer = new_peer();
    let params = object(&[("blob", Value::from("x".repeat(16 * 1024 * 1024)))]);
    let effects = call(&mut peer, "x", Some(&params), 1, Timeout::After(1_000.0));
    assert_eq!(
        order(&effects),
        vec!["arm:request:1", "cancel:request:1", "settle:1"]
    );
    assert_eq!(
        settles(&effects),
        vec![(1, Err("JSON-RPC message exceeded limit".to_owned()))]
    );
}

#[test]
fn the_queue_bound_refuses_with_rpc_writers_message() {
    let mut peer = RpcPeer::new(PeerConfig {
        max_queued_bytes: 8,
        ..PeerConfig::default()
    });
    let effects = call(&mut peer, "x", None, 1, Timeout::Disabled);
    assert_eq!(order(&effects), vec!["frame:send", "settle:1"]);
    assert_eq!(
        settles(&effects),
        vec![(1, Err("JSON-RPC write queue exceeded limit".to_owned()))]
    );
}

#[test]
fn only_one_write_is_in_flight_until_the_pipe_acknowledges_it() {
    let mut peer = new_peer();
    let first = match peer.notify("initialized", None) {
        Ok(effects) => effects,
        Err(error) => panic!("{error}"),
    };
    let second = match peer.notify("second", Some(&Value::Null)) {
        Ok(effects) => effects,
        Err(error) => panic!("{error}"),
    };
    assert_eq!(order(&first), vec!["frame:send", "write:0"]);
    assert_eq!(order(&second), vec!["frame:send"]);
    let released = peer.written(0);
    assert_eq!(
        writes(&released),
        vec![(
            1,
            r#"{"jsonrpc":"2.0","method":"second","params":null}"#.to_owned()
        )]
    );
}

#[test]
fn explicit_ids_keep_their_type_and_reject_reuse() {
    let cases = [
        (
            RpcId::Text(JsString::from("abc")),
            r#"{"jsonrpc":"2.0","id":"abc","method":"x"}"#,
        ),
        (
            RpcId::Number(7.0),
            r#"{"jsonrpc":"2.0","id":7,"method":"x"}"#,
        ),
    ];
    for (wire_id, expected) in cases {
        let mut peer = new_peer();
        let effects = match peer.request_with_id("x", None, 1, Timeout::Disabled, wire_id) {
            Ok(effects) => effects,
            Err(error) => panic!("{error}"),
        };
        assert_eq!(writes(&effects), vec![(0, expected.to_owned())]);
    }

    let mut peer = new_peer();
    call(&mut peer, "generated", None, 1, Timeout::Disabled);
    match peer.request_with_id("x", None, 2, Timeout::Disabled, RpcId::Number(1.0)) {
        Err(error) => assert_eq!(error.message(), "Request id already used"),
        Ok(_) => panic!("a generated id was reused"),
    }
    match peer.request_with_id(
        "x",
        None,
        3,
        Timeout::Disabled,
        RpcId::Text(JsString::from("5")),
    ) {
        Ok(_) => {}
        Err(error) => panic!("{error}"),
    }
    match peer.request_with_id(
        "x",
        None,
        4,
        Timeout::Disabled,
        RpcId::Text(JsString::from("5")),
    ) {
        Err(error) => assert_eq!(error.message(), "Request id already used"),
        Ok(_) => panic!("an explicit id was reused"),
    }
}

#[test]
fn an_explicit_id_above_1024_bytes_is_refused() {
    let mut peer = new_peer();
    match peer.request_with_id(
        "x",
        None,
        1,
        Timeout::Disabled,
        RpcId::Text(JsString::from("a".repeat(1025))),
    ) {
        Err(error) => assert_eq!(error.message(), "Invalid request id"),
        Ok(_) => panic!("a 1025-byte id was admitted"),
    }
}

#[test]
fn the_explicit_id_cap_is_4096() {
    let mut peer = new_peer();
    for at in 1..=4096u64 {
        let effects = match peer.request_with_id(
            "x",
            None,
            at,
            Timeout::Disabled,
            RpcId::Number(at as f64),
        ) {
            Ok(effects) => effects,
            Err(error) => panic!("id {at} refused: {error}"),
        };
        assert!(matches!(
            effects.first(),
            Some(PeerEffect::Frame {
                dir: Direction::Send,
                ..
            })
        ));
        let reply = peer.line(&format!(r#"{{"id":{at},"result":null}}"#));
        assert_eq!(settles(&reply).len(), 1);
    }
    match peer.request_with_id("x", None, 4097, Timeout::Disabled, RpcId::Number(4097.0)) {
        Err(error) => assert_eq!(error.message(), "JSON-RPC explicit id limit"),
        Ok(_) => panic!("the 4097th explicit id was admitted"),
    }
}

#[test]
fn a_replacement_shares_the_byte_cap() {
    let owner = PeerOwner::new(60);
    let mut retired = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
    let old = call(&mut retired, "old", None, 1, Timeout::Disabled);
    assert_eq!(writes(&old).len(), 1);
    retired.close("retired");

    let mut replacement = RpcPeer::with_owner(PeerConfig::default(), owner);
    let new = call(&mut replacement, "new", None, 2, Timeout::Disabled);
    assert_eq!(order(&new), vec!["frame:send", "settle:2"]);
    assert_eq!(
        settles(&new),
        vec![(2, Err("JSON-RPC write queue exceeded limit".to_owned()))]
    );
}

#[test]
fn the_shared_writer_refuses_a_queued_ack_and_sends_in_order() {
    let owner = PeerOwner::new(32 * 1024 * 1024);
    let mut retired = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
    let old = call(&mut retired, "old", None, 1, Timeout::Disabled);
    assert_eq!(writes(&old).len(), 1);
    retired.close("retired");

    let mut replacement = RpcPeer::with_owner(PeerConfig::default(), owner);
    let queued = call(&mut replacement, "new", None, 2, Timeout::Disabled);
    let third = call(&mut replacement, "third", None, 3, Timeout::Disabled);
    assert!(writes(&queued).is_empty());
    assert!(writes(&third).is_empty());

    // Tickets 1 and 2 are queued, not in flight: neither may be acknowledged,
    // and their payloads stay for their turn.
    assert!(writes(&replacement.written(1)).is_empty());
    assert!(writes(&replacement.written(2)).is_empty());

    // The current peer acknowledges the retired write; ticket 1 goes out.
    assert_eq!(
        writes(&replacement.written(0)),
        vec![(1, r#"{"jsonrpc":"2.0","id":2,"method":"new"}"#.to_owned())]
    );
    // One in flight: ticket 2 waits for ticket 1's acknowledgement.
    assert_eq!(
        writes(&replacement.written(1)),
        vec![(2, r#"{"jsonrpc":"2.0","id":3,"method":"third"}"#.to_owned())]
    );
    assert!(writes(&replacement.written(2)).is_empty());
}

#[test]
fn a_replacement_peer_keeps_the_pipes_id_reservations() {
    let owner = PeerOwner::new(32 * 1024 * 1024);
    let mut retired = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
    let old = call(&mut retired, "old", None, 1, Timeout::Disabled);
    assert_eq!(writes(&old)[0].0, 0);
    assert!(writes(&old)[0].1.contains(r#""id":1,"#));
    retired.close("retired");

    let mut replacement = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
    let new = call(&mut replacement, "new", None, 2, Timeout::Disabled);
    assert!(writes(&new).is_empty());
    let released = replacement.written(0);
    assert!(writes(&released)[0].1.contains(r#""id":2,"#));
    let late = replacement.line(r#"{"id":1,"result":"old"}"#);
    assert_eq!(order(&late), vec!["frame:recv"]);
    let fresh = replacement.line(r#"{"id":2,"result":"new"}"#);
    assert_eq!(order(&fresh), vec!["frame:recv", "settle:2"]);

    let mut retired = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
    let id = RpcId::Text(JsString::from("kept"));
    match retired.request_with_id("x", None, 3, Timeout::Disabled, id.clone()) {
        Ok(_) => {}
        Err(error) => panic!("{error}"),
    }
    retired.close("retired");
    let mut replacement = RpcPeer::with_owner(PeerConfig::default(), owner);
    match replacement.request_with_id("x", None, 4, Timeout::Disabled, id) {
        Err(error) => assert_eq!(error.message(), "Request id already used"),
        Ok(_) => panic!("the replacement reused a retired id"),
    }
}

#[test]
fn a_reply_slot_is_registered_before_another_peer_acknowledges_it() {
    let owner = PeerOwner::new(32 * 1024 * 1024);
    let mut requester = RpcPeer::with_owner(
        PeerConfig {
            max_incoming: 1,
            ..PeerConfig::default()
        },
        owner.clone(),
    );
    let mut other = RpcPeer::with_owner(PeerConfig::default(), owner.clone());

    let first = requester.line(r#"{"id":1,"method":"server"}"#);
    let answered = requester.answer(&server_id(&first), &Value::Null);
    let ticket = writes(&answered)[0].0;

    // The other peer acknowledges the shared in-flight reply. The slot was
    // registered with the ticket, so the requester admits its next request.
    assert!(writes(&other.written(ticket)).is_empty());
    let next = requester.line(r#"{"id":2,"method":"server"}"#);
    assert_eq!(order(&next), vec!["frame:recv", "server:2"]);
}

#[test]
fn a_retired_peers_record_goes_when_its_last_reply_is_written() {
    let owner = PeerOwner::new(32 * 1024 * 1024);
    let mut retired = RpcPeer::with_owner(
        PeerConfig {
            max_incoming: 1,
            ..PeerConfig::default()
        },
        owner.clone(),
    );
    let first = retired.line(r#"{"id":1,"method":"server"}"#);
    let answered = retired.answer(&server_id(&first), &Value::Null);
    let ticket = writes(&answered)[0].0;
    retired.close("retired");
    assert_eq!(owner.peer_records(), 1);

    assert!(owner.written(ticket));
    assert_eq!(owner.peer_records(), 0);
}

#[test]
fn retired_peer_records_stay_bounded_across_replacements() {
    let owner = PeerOwner::new(32 * 1024 * 1024);
    for _ in 0..1000 {
        let mut peer = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
        peer.close("retired");
    }
    assert_eq!(owner.peer_records(), 0);
}
