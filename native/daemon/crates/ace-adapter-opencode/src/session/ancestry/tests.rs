// SPDX-License-Identifier: Apache-2.0
//! The probe's synchronous half (`ancestry.ts:32`-`:171`).
//!
//! The probe lives in the host, as the tenant's does: `Host::receive` re-enters
//! `prove` the way `owns` → `prove` does under the tenant's probe lock, so a
//! delivery made while that lock is held fails here instead of passing.

use ace_json::{Value, json};
use std::cell::{RefCell, RefMut};
use std::sync::Mutex;

use super::{AncestryProbe, ProbeHost};

#[derive(Default)]
struct Host {
    /// `tenant.lock_ancestry()`: the probe the host's own callbacks take again.
    probe: RefCell<AncestryProbe>,
    owns: Vec<String>,
    directory: String,
    recovering: bool,
    /// `buffered` refuses, as a frame past the payload bound does.
    refuse: bool,
    /// `pending` refuses, after `buffered` succeeded.
    refuse_pending: bool,
    log: Mutex<Vec<String>>,
}

impl Host {
    fn new(owns: &[&str]) -> Self {
        Self {
            probe: RefCell::new(AncestryProbe::new()),
            owns: owns.iter().map(|id| (*id).to_owned()).collect(),
            directory: String::from("/work"),
            recovering: false,
            refuse: false,
            refuse_pending: false,
            log: Mutex::new(Vec::new()),
        }
    }

    /// The probe under the tenant's lock. A second borrow while one is held
    /// panics, which is what a delivery made under the lock does.
    fn probe(&self) -> RefMut<'_, AncestryProbe> {
        self.probe.borrow_mut()
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

    /// The tenant's `receive` → `owns` → `prove`: a receipt for a session this
    /// tree still does not own goes back to the probe.
    fn receive(&self, data: &Value, watermark: u64) -> Result<(), super::ProbeError> {
        self.record(format!("receive:{watermark}:{data}"));
        self.probe().prove(data, watermark, self)
    }

    fn buffered(&self, data: &Value, watermark: u64) -> Result<(), super::ProbeError> {
        self.record(format!("buffered:{watermark}:{data}"));
        if self.refuse {
            return Err(String::from("the receipt was refused"));
        }
        Ok(())
    }

    fn pending(&self, guard: &str) -> Result<(), super::ProbeError> {
        self.record(format!("pending:{guard}"));
        if self.refuse_pending {
            return Err(String::from("the note was refused"));
        }
        Ok(())
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

/// The tenant's `reconcile_probes`: the order is read under the probe's lock,
/// the events are delivered without it, then each probe finishes. `Host::receive`
/// re-enters `prove`, so a delivery made inside `reconcile_order` panics here.
fn reconcile(host: &Host) -> Result<(), super::ProbeError> {
    let order = host.probe.borrow().reconcile_order(host);
    for entry in order {
        for (data, watermark) in entry.events {
            host.receive(&data, watermark)?;
        }
        host.probe().finish(&entry.id, host);
    }
    Ok(())
}

#[test]
fn an_unowned_event_in_the_directory_waits_for_a_lookup() {
    let host = Host::new(&[]);
    host.probe()
        .prove(&event("session.text.delta", "child", "/work"), 3, &host)
        .expect("held");
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
    host.probe()
        .prove(&event("session.text.delta", "child", "/work"), 4, &host)
        .expect("held");
    assert_eq!(host.log().len(), 4);
    assert_eq!(host.probe.borrow().guard("child"), Some("ancestry:1"));

    // Owned, other-directory and session.created events are not evidence.
    let owned = Host::new(&["child"]);
    owned
        .probe()
        .prove(&event("session.text.delta", "child", "/work"), 1, &owned)
        .expect("held");
    owned
        .probe()
        .prove(&event("session.text.delta", "child", "/other"), 1, &owned)
        .expect("held");
    owned
        .probe()
        .prove(&event("session.created", "child", "/work"), 1, &owned)
        .expect("held");
    assert!(owned.log().is_empty());
    assert!(owned.probe.borrow().guard("child").is_none());
}

#[test]
fn the_probe_bounds_refuse_a_ninth_probe_or_a_33rd_event() {
    let host = Host::new(&[]);
    for index in 0..8 {
        host.probe()
            .prove(
                &event("session.text.delta", &format!("c{index}"), "/work"),
                1,
                &host,
            )
            .expect("held");
    }
    host.probe()
        .prove(&event("session.text.delta", "over", "/work"), 1, &host)
        .expect("held");
    assert!(host.log().iter().any(|entry| entry.starts_with("failed:")));

    let host = Host::new(&[]);
    for _ in 0..32 {
        host.probe()
            .prove(&event("session.text.delta", "child", "/work"), 1, &host)
            .expect("held");
    }
    let before = host.log().len();
    host.probe()
        .prove(&event("session.text.delta", "child", "/work"), 1, &host)
        .expect("held");
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
    host.probe()
        .prove(&event("session.text.delta", "child", "/work"), 3, &host)
        .expect("held");
    host.probe()
        .prove(&event("session.tool.progress", "child", "/work"), 4, &host)
        .expect("held");
    let mut seen = Vec::new();
    host.probe().observe_pending(&mut |data, watermark| {
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
    let mut host = Host::new(&[]);
    host.probe()
        .prove(&event("session.text.delta", "child", "/work"), 3, &host)
        .expect("held");
    host.probe().observe_pending(&mut |_, _| {});

    // Not owned and the lookup has not failed: it stays.
    reconcile(&host).expect("a pass");
    assert!(host.probe.borrow().guard("child").is_some());

    // Owned: the events replay and the receipt settles. The delivery re-enters
    // `prove` with the probe lock free.
    host.owns.push(String::from("child"));
    reconcile(&host).expect("a pass");
    assert!(host.probe.borrow().guard("child").is_none());
    assert!(
        host.log()
            .iter()
            .any(|entry| entry.starts_with("receive:3:"))
    );
    // The delivery re-entered `prove`, which saw an owned session and returned
    // before buffering: a delivery made under the probe lock would panic here.
    assert_eq!(
        host.log()
            .iter()
            .filter(|entry| entry.starts_with("buffered:"))
            .count(),
        1,
        "only the first receipt buffered: {:?}",
        host.log()
    );
    assert!(host.log().iter().any(|entry| entry == "settled:ancestry:1"));

    // A failed lookup settles without replaying.
    let host = Host::new(&[]);
    host.probe()
        .prove(&event("session.text.delta", "child", "/work"), 3, &host)
        .expect("held");
    assert!(host.probe().mark_failed("child"));
    reconcile(&host).expect("a pass");
    assert!(host.probe.borrow().guard("child").is_none());
    assert!(!host.log().iter().any(|entry| entry.starts_with("receive:")));
}

#[test]
fn a_receipt_sink_that_refuses_rolls_the_receipt_back() {
    // The receipt's note is refused: the probe leaves with it, and the guard
    // was never announced, so nothing settles it (`ancestry.ts:64`-`:82`).
    let mut host = Host::new(&[]);
    host.refuse = true;
    assert_eq!(
        host.probe()
            .prove(&event("session.text.delta", "child", "/work"), 3, &host),
        Err(String::from("the receipt was refused"))
    );
    assert!(host.probe.borrow().guard("child").is_none());
    assert!(host.probe.borrow().shells().is_empty());
    assert!(
        !host.log().iter().any(|entry| entry.starts_with("settled:")),
        "{:?}",
        host.log()
    );

    // A later receipt starts a new probe: the sequence moved on by one.
    host.refuse = false;
    host.probe()
        .prove(&event("session.text.delta", "child", "/work"), 4, &host)
        .expect("held again");
    assert_eq!(host.probe.borrow().guard("child"), Some("ancestry:2"));

    // The pending note refusing leaves the probe gone but settles its guard,
    // because `pendingStarted` was set before the call.
    let mut host = Host::new(&[]);
    host.refuse_pending = true;
    assert_eq!(
        host.probe()
            .prove(&event("session.text.delta", "child", "/work"), 3, &host),
        Err(String::from("the note was refused"))
    );
    assert!(host.probe.borrow().guard("child").is_none());
    assert!(
        host.log().iter().any(|entry| entry == "settled:ancestry:1"),
        "{:?}",
        host.log()
    );
}

#[test]
fn a_held_shell_names_its_probe_for_the_shell_snapshots() {
    let host = Host::new(&[]);
    host.probe()
        .prove(
            &json!({
                "id": "e",
                "type": "shell.created",
                "data": { "sessionID": "child", "info": { "id": "sh1" } },
                "location": { "directory": "/work" },
            }),
            1,
            &host,
        )
        .expect("held");
    let shells = host.probe.borrow().shells();
    assert_eq!(shells.get("sh1").map(String::as_str), Some("child"));

    let owned = Host::new(&["child"]);
    assert!(
        host.probe
            .borrow()
            .needs_shell_snapshots(&|_, _| false, &owned)
    );
    assert!(
        !host
            .probe
            .borrow()
            .needs_shell_snapshots(&|id, owner| id == "sh1" && owner == "child", &owned)
    );
    let unowned = Host::new(&[]);
    assert!(
        !host
            .probe
            .borrow()
            .needs_shell_snapshots(&|_, _| false, &unowned)
    );
}
