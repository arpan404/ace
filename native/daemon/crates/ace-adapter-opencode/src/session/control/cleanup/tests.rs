// SPDX-License-Identifier: Apache-2.0
//! The cleanup plan (`cleanup.ts`): shells first, then the tree deepest first, each
//! in the directory ownership knows for it, and nothing for a session ace does not
//! own.

use super::plan;
use crate::session::ownership::SessionOwnership;
use ace_json::json;

fn snapshot(id: &str, parent: &str) -> ace_json::Value {
    json!({
        "id": id,
        "projectID": "p1",
        "location": { "directory": "/work" },
        "parentID": parent,
    })
}

fn owned() -> SessionOwnership {
    let mut ownership = SessionOwnership::new("/work", "", None);
    ownership.establish(&snapshot("root", "")).expect("root");
    for (id, parent) in [("child", "root"), ("grandchild", "child")] {
        let created = json!({
            "id": "e",
            "type": "session.created",
            "data": {
                "sessionID": id,
                "parentID": parent,
                "projectID": "p1",
                "location": { "directory": "/work" },
            },
        });
        assert!(ownership.accept(&created).expect("in bounds"), "{id}");
    }
    ownership
        .shells_mut()
        .insert(String::from("sh_1"), String::from("child"));
    // A shell whose session ownership never learned of must not be removed.
    ownership
        .shells_mut()
        .insert(String::from("sh_2"), String::from("elsewhere"));
    ownership
}

#[test]
fn shells_go_first_then_the_tree_deepest_first() {
    let ownership = owned();
    let requests = plan(&ownership).expect("a plan");
    let targets: Vec<&str> = requests
        .iter()
        .map(|request| request.call.path.as_str())
        .collect();
    assert_eq!(
        targets,
        [
            "/api/shell/sh_1",
            "/api/session/grandchild/interrupt",
            "/api/session/child/interrupt",
            "/api/session/root/interrupt",
        ],
        "a shell with no owned session is skipped"
    );
    assert_eq!(
        requests[0].call.target(),
        "/api/shell/sh_1?location%5Bdirectory%5D=%2Fwork"
    );
    assert_eq!(requests[0].call.body, None, "a removal sends no body");
    assert!(
        requests.iter().all(|request| request.directory == "/work"),
        "each request is scoped to its own session's directory"
    );
}

#[test]
fn an_unestablished_tree_cleans_nothing() {
    // `if (!ownership.root) return`: the TypeScript never reaches the shells.
    let mut ownership = SessionOwnership::new("/work", "", None);
    ownership
        .shells_mut()
        .insert(String::from("sh_1"), String::from("root"));
    assert!(plan(&ownership).expect("no plan").is_empty());
}

#[test]
fn a_tree_ace_does_not_own_is_not_cleaned() {
    let mut ownership = SessionOwnership::new("/work", "", None);
    ownership.establish(&snapshot("root", "")).expect("root");
    let requests = plan(&ownership).expect("a plan");
    assert_eq!(requests.len(), 1, "only the root");
    assert_eq!(requests[0].call.target(), "/api/session/root/interrupt");
}
