//! Ports `packages/protocol/src/relay-handshake.test.ts`: the allowlist, the one-credential
//! rule, the subscribe bounds and distinct ids, and the confirmation's own fields.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::{EarlyScope, HelloConfirm, HelloEarly, RELAY_NK_HANDSHAKE};

fn json(text: &str) -> ace_json::Value {
    ace_json::parse(text).unwrap()
}

fn hello(extra: &str) -> String {
    format!(
        "{{\"type\":\"hello.early\",\"protocolVersion\":1,\"deviceId\":\"device-1\",\
         \"ticket\":\"{}{}\"{extra}}}",
        "a".repeat(60),
        "b".repeat(4)
    )
}

#[test]
fn a_ticket_hello_and_a_grant_hello_parse_and_one_credential_is_required() {
    assert_eq!(RELAY_NK_HANDSHAKE, "nk1");
    assert!(HelloEarly::parse(&json(&hello(""))).is_some());
    let ticket = format!("{}{}", "a".repeat(60), "b".repeat(4));
    let with_grant = hello("").replace(&format!("\"ticket\":\"{ticket}\""), "\"grant\":\"grant\"");
    assert!(HelloEarly::parse(&json(&with_grant)).is_some());
    // Both, or neither, is refused.
    let both = hello("").replace("}", ",\"grant\":\"grant\"}");
    assert!(HelloEarly::parse(&json(&both)).is_none());
    let neither = "{\"type\":\"hello.early\",\"protocolVersion\":1,\"deviceId\":\"device-1\"}";
    assert!(HelloEarly::parse(&json(neither)).is_none());
}

#[test]
fn fields_outside_the_allowlist_are_refused() {
    for extra in [
        ",\"token\":\"x\"",
        ",\"machineCode\":\"1234\"",
        ",\"installId\":\"install-0001\"",
        ",\"channel\":\"files\"",
        ",\"nextTicket\":true",
        ",\"mediaTicket\":\"x\"",
        ",\"presence\":\"online\"",
        ",\"commands\":[]",
    ] {
        let text = hello(extra);
        assert!(HelloEarly::parse(&json(&text)).is_none(), "{extra}");
    }
}

#[test]
fn a_protocol_version_other_than_one_or_a_bad_ticket_is_refused() {
    let two = hello("").replace("\"protocolVersion\":1", "\"protocolVersion\":2");
    assert!(HelloEarly::parse(&json(&two)).is_none());
    let short = hello("").replace(&"a".repeat(60), &"a".repeat(59));
    assert!(HelloEarly::parse(&json(&short)).is_none());
    let upper = hello("").replace(&"a".repeat(60), &"A".repeat(60));
    assert!(HelloEarly::parse(&json(&upper)).is_none());
}

fn subscribe(id: &str, scope: &str) -> String {
    format!("{{\"subscriptionId\":\"{id}\",\"scope\":{scope}}}")
}

#[test]
fn at_most_four_thread_subscribes_and_two_sidebar_windows_with_distinct_ids() {
    let thread = "{\"kind\":\"thread\",\"threadId\":\"t\"}";
    let window = "{\"kind\":\"threads\",\"window\":{\"limit\":20}}";
    let subs = |items: &[String]| format!(",\"subscribes\":[{}]", items.join(","));
    let ok: Vec<String> = (0..4)
        .map(|n| subscribe(&format!("t{n}"), thread))
        .chain((0..2).map(|n| subscribe(&format!("w{n}"), window)))
        .collect();
    assert!(HelloEarly::parse(&json(&hello(&subs(&ok)))).is_some());
    let five_threads: Vec<String> = (0..5)
        .map(|n| subscribe(&format!("t{n}"), thread))
        .collect();
    assert!(HelloEarly::parse(&json(&hello(&subs(&five_threads)))).is_none());
    let three_windows: Vec<String> = (0..3)
        .map(|n| subscribe(&format!("w{n}"), window))
        .collect();
    assert!(HelloEarly::parse(&json(&hello(&subs(&three_windows)))).is_none());
    let duplicates = vec![subscribe("same", thread), subscribe("same", thread)];
    assert!(HelloEarly::parse(&json(&hello(&subs(&duplicates)))).is_none());
}

#[test]
fn a_scope_is_strict_and_a_window_takes_only_its_limit_project_and_archived() {
    let thread_with_more = subscribe("t", "{\"kind\":\"thread\",\"threadId\":\"t\",\"tail\":{}}");
    assert!(
        HelloEarly::parse(&json(&hello(&format!(
            ",\"subscribes\":[{thread_with_more}]"
        ))))
        .is_none()
    );
    let window_with_resume = subscribe(
        "w",
        "{\"kind\":\"threads\",\"window\":{\"limit\":20,\"resume\":\"x\"}}",
    );
    assert!(
        HelloEarly::parse(&json(&hello(&format!(
            ",\"subscribes\":[{window_with_resume}]"
        ))))
        .is_none()
    );
    let ok = subscribe(
        "w",
        "{\"kind\":\"threads\",\"window\":{\"limit\":20,\"project\":\"p\",\"archived\":true}}",
    );
    let parsed = HelloEarly::parse(&json(&hello(&format!(",\"subscribes\":[{ok}]")))).unwrap();
    assert_eq!(
        parsed.subscribes[0].scope,
        EarlyScope::Threads {
            window: super::Window {
                limit: 20,
                project: Some("p".to_owned()),
                archived: Some(true),
            }
        }
    );
    assert_eq!(parsed.early_threads(), Vec::<&str>::new());
}

#[test]
fn debug_names_a_ticket_and_a_grant_by_presence_never_by_value() {
    let ticket = format!("{}{}", "a".repeat(60), "b".repeat(4));
    let parsed = HelloEarly::parse(&json(&hello(""))).unwrap();
    let printed = format!("{parsed:?}");
    assert!(!printed.contains(&ticket), "{printed}");
    assert!(printed.contains("ticket: true"), "{printed}");
    let grant_payload = hello("").replace(
        &format!("\"ticket\":\"{ticket}\""),
        "\"grant\":\"sensitive-grant\"",
    );
    let grant = HelloEarly::parse(&json(&grant_payload)).unwrap();
    let printed = format!("{grant:?}");
    assert!(!printed.contains("sensitive-grant"), "{printed}");
    assert!(printed.contains("grant: true"), "{printed}");
    let confirm = HelloConfirm::parse(&json(
        "{\"type\":\"hello.confirm\",\"machineCode\":\"1234\"}",
    ))
    .unwrap();
    let printed = format!("{confirm:?}");
    assert!(!printed.contains("1234"), "{printed}");
    assert!(printed.contains("machine_code: true"), "{printed}");
}

#[test]
fn a_confirmation_s_link_accepts_extra_keys_as_the_protocol_s_plain_object_does() {
    let full = "{\"type\":\"hello.confirm\",\"link\":{\"deviceId\":\"d\",\
                \"proof\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"future\":1}}";
    let confirm = HelloConfirm::parse(&json(full)).unwrap();
    assert_eq!(confirm.link.as_ref().unwrap().device_id, "d");
}

#[test]
fn a_confirmation_carries_the_device_fields_and_the_allowlist() {
    assert!(HelloConfirm::parse(&json("{\"type\":\"hello.confirm\"}")).is_some());
    let full = "{\"type\":\"hello.confirm\",\"installId\":\"01936d1e-3f8a-7c2b\",\
                \"link\":{\"deviceId\":\"d\",\"proof\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"},\
                \"nextTicket\":true,\"machineCode\":\"1234\"}";
    let confirm = HelloConfirm::parse(&json(full)).unwrap();
    assert_eq!(confirm.install_id.as_deref(), Some("01936d1e-3f8a-7c2b"));
    assert_eq!(confirm.link.as_ref().unwrap().device_id, "d");
    assert!(confirm.next_ticket);
    assert_eq!(confirm.machine_code.as_deref(), Some("1234"));
    for extra in [
        ",\"token\":\"x\"",
        ",\"ticket\":\"x\"",
        ",\"channel\":\"files\"",
        ",\"grant\":\"g\"",
    ] {
        let text = format!("{{\"type\":\"hello.confirm\"{extra}}}");
        assert!(HelloConfirm::parse(&json(&text)).is_none(), "{extra}");
    }
    // A proof is 43 base64url characters; an install id 8-64 of letters, digits and '-'.
    let short_proof = full.replace(&"A".repeat(43), &"A".repeat(42));
    assert!(HelloConfirm::parse(&json(&short_proof)).is_none());
    let short_install = full.replace("01936d1e-3f8a-7c2b", "short");
    assert!(HelloConfirm::parse(&json(&short_install)).is_none());
}
