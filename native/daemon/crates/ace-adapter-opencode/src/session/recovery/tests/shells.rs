// SPDX-License-Identifier: Apache-2.0
//! The pass's walk (`recovery.ts`): the order of its reads and frames, the
//! pagination and visit bounds, the interaction staging and the settlement
//! check. The host is real ownership and real history; only the `http` replies
//! are scripted.

use super::{Host, answer, drive, ops, reply};
use ace_json::json;

use crate::session::http::Reply;
use crate::session::recovery::{Recovery, RecoveryError};

#[test]
fn a_shell_the_listing_missed_is_read_exactly_and_a_404_is_its_absence() {
    let mut host = Host::new("root");
    host.pending.insert("sh2".to_owned(), "root".to_owned());
    let (machine, first) = Recovery::begin("root");
    let requests = drive(machine, &host, first, &mut |op, params| {
        if op == "shell.list" {
            return reply(json!({
                "location": { "directory": "/work" },
                "data": [
                    { "id": "sh1", "status": "running", "metadata": { "sessionID": "root" } },
                    { "id": "sh9", "status": "running", "metadata": { "sessionID": "elsewhere" } },
                ],
            }));
        }
        if op == "shell.get" {
            return Reply::parse(false, r#"{"message":"gone","status":404}"#);
        }
        answer(op, params)
    })
    .expect("the pass");
    assert_eq!(
        ops(&requests)
            .iter()
            .filter(|op| *op == "shell.get")
            .count(),
        1,
        "only the pending shell the listing missed"
    );
    let shells: Vec<(String, String)> = host
        .shells
        .borrow()
        .iter()
        .map(|(id, owner, _)| (id.clone(), owner.clone()))
        .collect();
    assert_eq!(
        shells,
        [
            ("sh1".to_owned(), "root".to_owned()),
            ("sh2".to_owned(), "root".to_owned()),
        ]
    );
    let receives = host.receives.borrow().join("\n");
    assert!(receives.contains(r#""id":"snapshot:shell:sh1:running""#));
    assert!(receives.contains(r#""id":"snapshot:shell:sh2:deleted""#));
    assert!(
        !receives.contains("sh9"),
        "another directory's shell is not ours"
    );

    // Any refusal but a 404 is an incomplete recovery.
    let mut host = Host::new("root");
    host.pending.insert("sh2".to_owned(), "root".to_owned());
    let (machine, first) = Recovery::begin("root");
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "shell.get" {
            return Reply::parse(false, r#"{"message":"boom"}"#);
        }
        answer(op, params)
    });
    assert_eq!(failed, Err(RecoveryError::ShellIncomplete));
}
