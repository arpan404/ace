#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Ports `packages/projection/src/wire-trim.test.ts` by case name. Byte equality with the
//! TypeScript is `tests/trim_vectors.rs`; these cases assert the behaviour each name guards.
//!
//! - "gives a client that asked for every trim the same thread snapshot in fewer bytes"
//! - "keeps an item that is still streaming marked incomplete"
//! - "trims the items of a history page"
//! - "sends a client that asked for nothing exactly what the daemon built"
//! - "sends each provider's capabilities once, however many threads and patches use them"
//! - "leaves a thread without capabilities when its key was never taught, rather than failing"
//! - "does not mutate the message the daemon shares with other connections"
//! - "sends a repeated workspace icon and effective capabilities once for the whole list"
//! - "restores every thread exactly, including one whose project has no icon"
//! - "sends a thread whole to a client that did not ask for the trim"
//! - "only clients advertising spade-hidden receive the hidden code and live-end reason"

use ace_fanout::{SUPPORTED_TRIMS, WireRestorer, WireTrimmer};
use ace_json::Value;

fn parse(text: &str) -> Value {
    ace_json::parse(text).expect("parse JSON")
}

fn bytes(value: &Value) -> String {
    ace_json::to_string(value)
}

const CAPABILITIES: &str = r#"{"steer":true,"interruptCascades":true,"resume":true,"fork":true,"subagentTranscripts":true,"backgroundTaskControl":true,"backgroundVisibility":"full","planMode":true,"tokenUsage":true,"imageInput":true,"rewindFiles":false,"launchOptions":["effort","serviceTier"]}"#;

fn thread(id: &str) -> String {
    format!(
        r#"{{"id":"{id}","workspaceId":"w","title":"{id}","provider":"codex","status":{{"state":"new"}},"createdAt":1,"updatedAt":1,"capabilities":{CAPABILITIES}}}"#
    )
}

fn thread_snapshot(thread_json: &str) -> Value {
    parse(&format!(
        r#"{{"type":"snapshot","subscriptionId":"s","seq":4,"view":{{"kind":"thread","seq":4,"thread":{thread_json},"agents":{{}},"agentChildren":{{}},"runs":{{}},"items":{{}},"itemOrder":[],"itemsBefore":null,"interactions":{{}},"backgroundTasks":{{}},"usage":{{}},"contextMeters":{{}},"usageSnapshots":{{}}}}}}"#
    ))
}

fn threads_snapshot(threads: &[String]) -> Value {
    let rows: Vec<String> = threads
        .iter()
        .map(|thread| {
            let value = parse(thread);
            let Some(Value::String(id)) = value.get("id") else {
                panic!("id");
            };
            format!("\"{}\":{}", id.as_str(), bytes(&value))
        })
        .collect();
    parse(&format!(
        r#"{{"type":"snapshot","subscriptionId":"s","seq":1,"view":{{"kind":"threads","seq":1,"threads":{{{}}}}}}}"#,
        rows.join(",")
    ))
}

fn every() -> Vec<&'static str> {
    SUPPORTED_TRIMS.to_vec()
}

/// "gives a client that asked for every trim the same thread snapshot in fewer bytes".
#[test]
fn every_trim_sends_the_same_snapshot_in_fewer_bytes() {
    let original = parse(&ace_json::to_string(&thread_snapshot(&thread("t"))).replace(
        r#""items":{},"itemOrder":[],"itemsBefore":null"#,
        r#""items":{"m1":{"id":"m1","agentId":"a","type":"message","role":"assistant","complete":true,"synthetic":false,"createdAt":1,"parts":[],"raw":[]},"m2":{"id":"m2","agentId":"a","type":"message","role":"assistant","complete":false,"synthetic":false,"createdAt":1,"parts":[],"raw":[]}},"itemOrder":["m1","m2"],"itemsBefore":null"#,
    ));
    let before = bytes(&original).len();
    let frames = WireTrimmer::new(Some(&every())).outgoing(original);
    let after: usize = frames.iter().map(|frame| bytes(frame).len()).sum();
    assert!(after < before, "{after} !< {before}");
}

/// "keeps an item that is still streaming marked incomplete".
#[test]
fn an_item_still_streaming_keeps_its_incomplete_mark() {
    let message = parse(
        r#"{"type":"snapshot","subscriptionId":"s","seq":4,"view":{"kind":"thread","seq":4,"thread":{"id":"t","workspaceId":"w","title":"t","provider":"codex","status":{"state":"new"},"createdAt":1,"updatedAt":1},"agents":{},"agentChildren":{},"runs":{},"items":{"m1":{"id":"m1","agentId":"a","type":"message","role":"assistant","complete":true,"synthetic":false,"createdAt":1,"parts":[],"raw":[]},"m2":{"id":"m2","agentId":"a","type":"message","role":"assistant","complete":false,"synthetic":false,"createdAt":1,"parts":[],"raw":[]}},"itemOrder":["m1","m2"],"itemsBefore":null,"interactions":{},"backgroundTasks":{},"usage":{},"contextMeters":{},"usageSnapshots":{}}}"#,
    );
    let frames = WireTrimmer::new(Some(&every())).outgoing(message);
    let sent = bytes(&frames[0]);
    assert!(!sent.contains("\"complete\":true"));
    assert!(sent.contains("\"complete\":false"));
}

/// "trims the items of a history page".
#[test]
fn a_history_pages_items_are_trimmed() {
    let page = parse(
        r#"{"type":"items.page","requestId":"r","seq":2,"threadId":"t","items":[{"id":"m1","agentId":"a","type":"message","role":"assistant","complete":true,"synthetic":false,"createdAt":1,"parts":[],"raw":[]}],"itemSeqs":{"m1":1},"itemsBefore":null}"#,
    );
    let frames = WireTrimmer::new(Some(&every())).outgoing(page);
    assert!(!bytes(&frames[0]).contains("\"complete\""));
}

/// "sends a client that asked for nothing exactly what the daemon built".
#[test]
fn a_client_that_asked_for_nothing_gets_the_message_as_built() {
    let original = thread_snapshot(&thread("t"));
    let before = bytes(&original);
    let frames = WireTrimmer::new(None).outgoing(original);
    assert_eq!(frames.len(), 1);
    assert_eq!(bytes(&frames[0]), before);
    let frames = WireTrimmer::new(Some(&["unknown-trim"])).outgoing(parse(&before));
    assert_eq!(bytes(&frames[0]), before);
}

/// "sends each provider's capabilities once, however many threads and patches use them".
#[test]
fn capabilities_are_taught_once_however_many_threads_use_them() {
    let mut trimmer = WireTrimmer::new(Some(&every()));
    let frames = trimmer.outgoing(threads_snapshot(&[thread("a"), thread("b"), thread("c")]));
    let kinds: Vec<&str> = frames
        .iter()
        .map(|frame| match frame.get("type") {
            Some(Value::String(kind)) => kind.as_str(),
            _ => panic!("type"),
        })
        .collect();
    assert_eq!(
        kinds,
        vec!["provider.capabilities", "snapshot"],
        "one key for one capability set"
    );
    let patch = parse(&format!(
        r#"{{"type":"threads.patch","subscriptionId":"s","seq":2,"threads":{{"a":{{"id":"a","workspaceId":"w","title":"a","provider":"codex","status":{{"state":"new"}},"createdAt":1,"updatedAt":1,"capabilities":{CAPABILITIES}}}}},"removed":[],"window":{{"before":null,"total":3,"counts":[]}}}}"#
    ));
    // The three rows shared one set; a patch using it again needs no teaching frame.
    let frames = trimmer.outgoing(patch);
    assert_eq!(frames.len(), 1);
}

/// "leaves a thread without capabilities when its key was never taught, rather than failing".
#[test]
fn a_key_never_taught_leaves_the_thread_without_capabilities() {
    let frames = WireTrimmer::new(Some(&every())).outgoing(thread_snapshot(&thread("t")));
    // Skip the teaching frame, as a client that joined later would.
    let sent = frames.last().expect("snapshot");
    let mut restorer = WireRestorer::new();
    let restored = restorer.restore(sent.clone()).expect("snapshot");
    let text = bytes(&restored);
    assert!(!text.contains("capabilitiesRef"));
    assert!(!text.contains("\"capabilities\""));
}

/// "does not mutate the message the daemon shares with other connections".
#[test]
fn the_shared_message_is_not_mutated() {
    let original = thread_snapshot(&thread("t"));
    let before = bytes(&original);
    WireTrimmer::new(Some(&every())).outgoing_cloned(&original);
    assert_eq!(bytes(&original), before);
}

/// "sends a repeated workspace icon and effective capabilities once for the whole list".
#[test]
fn a_repeated_workspace_icon_is_sent_once() {
    let icon = format!("data:image/png;base64,{}", "A".repeat(4096));
    let project = |id: &str| {
        format!(
            r#"{{"id":"{id}","workspaceId":"w","title":"{id}","provider":"codex","status":{{"state":"new"}},"createdAt":1,"updatedAt":1,"capabilities":{CAPABILITIES},"effectiveCapabilities":{CAPABILITIES},"details":{{"workspace":{{"id":"w","name":"ace","path":"/ace","icon":"{icon}"}}}}}}"#
        )
    };
    let snapshot = threads_snapshot(&[project("a"), project("b"), project("c")]);
    let before = bytes(&snapshot).len();
    let frames = WireTrimmer::new(Some(&every())).outgoing(snapshot);
    let after: usize = frames.iter().map(|frame| bytes(frame).len()).sum();
    assert!(after < before / 2, "{after} !< {before}/2");
}

/// "restores every thread exactly, including one whose project has no icon".
#[test]
fn every_shared_thread_restores() {
    let project = |id: &str| {
        format!(
            r#"{{"id":"{id}","workspaceId":"w","title":"{id}","provider":"codex","status":{{"state":"new"}},"createdAt":1,"updatedAt":1,"effectiveCapabilities":{CAPABILITIES},"details":{{"workspace":{{"id":"w","name":"ace","path":"/ace"}}}}}}"#
        )
    };
    let original = threads_snapshot(&[project("a"), project("b")]);
    let frames = WireTrimmer::new(Some(&every())).outgoing(original.clone());
    let mut restorer = WireRestorer::new();
    let mut restored = None;
    for frame in frames {
        if let Some(message) = restorer.restore(frame) {
            restored = Some(message);
        }
    }
    // The TS compares decoded messages, not bytes: a restored row's fields can come back in
    // another key order (the daemon appends what it restores), which a reader never sees.
    assert_eq!(restored.as_ref(), Some(&original));
}

/// "sends a thread whole to a client that did not ask for the trim".
#[test]
fn a_client_without_the_share_trim_gets_each_icon() {
    let icon = format!("data:image/png;base64,{}", "A".repeat(64));
    let project = |id: &str| {
        format!(
            r#"{{"id":"{id}","workspaceId":"w","title":"{id}","provider":"codex","status":{{"state":"new"}},"createdAt":1,"updatedAt":1,"details":{{"workspace":{{"id":"w","name":"ace","path":"/ace","icon":"{icon}"}}}}}}"#
        )
    };
    let snapshot = threads_snapshot(&[project("a"), project("b")]);
    let frames = WireTrimmer::new(Some(&["item-defaults"])).outgoing(snapshot);
    assert_eq!(bytes(&frames[0]).matches(&icon).count(), 2);
}

/// "only clients advertising spade-hidden receive the hidden code and live-end reason".
#[test]
fn only_clients_advertising_spade_hidden_receive_hidden() {
    let messages = [
        parse(
            r#"{"type":"spade.http.result","requestId":"h","result":{"kind":"error","code":"hidden","message":"Spade is hidden."}}"#,
        ),
        parse(r#"{"type":"spade.live.ended","requestId":"l","reason":"hidden"}"#),
    ];
    for trims in [None, Some(vec!["spade-hidden"])] {
        let mut trimmer = WireTrimmer::new(trims.as_deref());
        let frames: Vec<String> = messages
            .iter()
            .flat_map(|message| trimmer.outgoing(message.clone()))
            .map(|frame| bytes(&frame))
            .collect();
        let code = if trims.is_some() {
            "hidden"
        } else {
            "unavailable"
        };
        assert!(frames[0].contains(&format!("\"{code}\"")), "{}", frames[0]);
        assert!(frames[1].contains(&format!("\"{code}\"")), "{}", frames[1]);
    }
}
