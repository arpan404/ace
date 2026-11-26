// SPDX-License-Identifier: Apache-2.0
//! The probe's synchronous half (`ancestry.ts:32`-`:171`).

use ace_json::{Value, json};
use std::sync::Mutex;

use super::{AncestryProbe, ProbeHost};

#[derive(Default)]
struct Host {
    owns: Vec<String>,
    directory: String,
    recovering: bool,
    log: Mutex<Vec<String>>,
}

impl Host {
    fn new(owns: &[&str]) -> Self {
        Self {
            owns: owns.iter().map(|id| (*id).to_owned()).collect(),
            directory: String::from("/work"),
            recovering: false,
            log: Mutex::new(Vec::new()),
        }
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().expect("log").clone()
    }

    fn record(&self, entry: String) {
        self.log.lock().expect("log").push(entry);
    }
}

impl ProbeHost for Host {
    fn owns_session(&self, id: &str) -> bool {
        self.owns.iter().any(|known| known == id)
    }

    fn directory(&self) -> String {
        self.directory.clone()
    }

    fn recovering(&self) -> bool {
        self.recovering
    }

    fn info(&self, info: &Value) {
        self.record(format!("info:{info}"));
    }

    fn receive(&self, data: &Value, watermark: u64) {
        self.record(format!("receive:{watermark}:{data}"));
    }

    fn buffered(&self, data: &Value, watermark: u64) {
        self.record(format!("buffered:{watermark}:{data}"));
    }

    fn pending(&self, guard: &str) {
        self.record(format!("pending:{guard}"));
    }

    fn settled(&self, guard: &str) {
        self.record(format!("settled:{guard}"));
    }

    fn failed(&self, data: &Value) {
        self.record(format!("failed:{data}"));
    }

    fn lookup(&self, id: &str, guard: &str) {
        self.record(format!("lookup:{id}:{guard}"));
    }
}

fn event(kind: &str, session: &str, directory: &str) -> Value {
    json!({
        "id": "e",
        "type": kind,
        "data": { "sessionID": session },
        "location": { "directory": directory },
    })
}

#[test]
fn an_unowned_event_in_the_directory_waits_for_a_lookup() {
    let host = Host::new(&[]);
    let mut probe = AncestryProbe::new();
    probe.prove(&event("session.text.delta", "child", "/work"), 3, &host);
    assert_eq!(
        host.log(),
        vec![
            format!(
                "buffered:3:{}",
                event("session.text.delta", "child", "/work")
            ),
            "pending:ancestry:1".to_owned(),
            "lookup:child:ancestry:1".to_owned(),
        ]
    );

    // The same session joins the probe: no second lookup, one more event.
    probe.prove(&event("session.text.delta", "child", "/work"), 4, &host);
    assert_eq!(host.log().len(), 4);
    assert_eq!(probe.guard("child"), Some("ancestry:1"));

    // Owned, other-directory and session.created events are not evidence.
    let mut probe = AncestryProbe::new();
    let owned = Host::new(&["child"]);
    probe.prove(&event("session.text.delta", "child", "/work"), 1, &owned);
    probe.prove(&event("session.text.delta", "child", "/other"), 1, &owned);
    probe.prove(&event("session.created", "child", "/work"), 1, &owned);
    assert!(owned.log().is_empty());
    assert!(probe.guard("child").is_none());
}

#[test]
fn the_probe_bounds_refuse_a_ninth_probe_or_a_33rd_event() {
    let host = Host::new(&[]);
    let mut probe = AncestryProbe::new();
    for index in 0..8 {
        probe.prove(
            &event("session.text.delta", &format!("c{index}"), "/work"),
            1,
            &host,
        );
    }
    probe.prove(&event("session.text.delta", "over", "/work"), 1, &host);
    assert!(host.log().iter().any(|entry| entry.starts_with("failed:")));

    let host = Host::new(&[]);
    let mut probe = AncestryProbe::new();
    for _ in 0..32 {
        probe.prove(&event("session.text.delta", "child", "/work"), 1, &host);
    }
    let before = host.log().len();
    probe.prove(&event("session.text.delta", "child", "/work"), 1, &host);
    assert_eq!(host.log().len(), before + 1);
    assert!(
        host.log()
            .last()
            .is_some_and(|entry| entry.starts_with("failed:"))
    );
}

#[test]
fn a_recovery_pass_replays_the_held_events_into_the_evidence() {
    let host = Host::new(&[]);
    let mut probe = AncestryProbe::new();
    probe.prove(&event("session.text.delta", "child", "/work"), 3, &host);
    probe.prove(&event("session.tool.progress", "child", "/work"), 4, &host);
    let mut seen = Vec::new();
    probe.observe_pending(&mut |data, watermark| {
        seen.push((
            data["type"].as_str().unwrap_or_default().to_owned(),
            watermark,
        ));
    });
    assert_eq!(
        seen,
        vec![
            (String::from("session.text.delta"), 3),
            (String::from("session.tool.progress"), 4),
        ]
    );
}

#[test]
fn reconciled_replays_an_owned_probe_and_finishes_every_looked_up_one() {
    let host = Host::new(&[]);
    let mut probe = AncestryProbe::new();
    probe.prove(&event("session.text.delta", "child", "/work"), 3, &host);
    probe.observe_pending(&mut |_, _| {});

    // Not owned and the lookup has not failed: it stays.
    probe.reconciled(&host);
    assert!(probe.guard("child").is_some());

    // Owned: the events replay and the receipt settles.
    let host = Host::new(&["child"]);
    probe.reconciled(&host);
    assert!(probe.guard("child").is_none());
    assert!(
        host.log()
            .iter()
            .any(|entry| entry.starts_with("receive:3:"))
    );
    assert!(host.log().iter().any(|entry| entry == "settled:ancestry:1"));

    // A failed lookup settles without replaying.
    let host = Host::new(&[]);
    let mut probe = AncestryProbe::new();
    probe.prove(&event("session.text.delta", "child", "/work"), 3, &host);
    assert!(probe.mark_failed("child"));
    probe.reconciled(&host);
    assert!(probe.guard("child").is_none());
    assert!(!host.log().iter().any(|entry| entry.starts_with("receive:")));
}

#[test]
fn a_held_shell_names_its_probe_for_the_shell_snapshots() {
    let host = Host::new(&[]);
    let mut probe = AncestryProbe::new();
    probe.prove(
        &json!({
            "id": "e",
            "type": "shell.created",
            "data": { "sessionID": "child", "info": { "id": "sh1" } },
            "location": { "directory": "/work" },
        }),
        1,
        &host,
    );
    let shells = probe.shells();
    assert_eq!(shells.get("sh1").map(String::as_str), Some("child"));

    let owned = Host::new(&["child"]);
    assert!(probe.needs_shell_snapshots(&|_, _| false, &owned));
    assert!(!probe.needs_shell_snapshots(&|id, owner| id == "sh1" && owner == "child", &owned));
    let unowned = Host::new(&[]);
    assert!(!probe.needs_shell_snapshots(&|_, _| false, &unowned));
}
