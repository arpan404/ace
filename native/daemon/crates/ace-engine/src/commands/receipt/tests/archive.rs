// SPDX-License-Identifier: Apache-2.0
//! The archive's fence (`thread-fence.ts`, E5.10): the person decided at `beforeSeq`, so an
//! archive is refused once anything that could be work they didn't see happened after it, in the
//! thread or any thread it would stop.

use super::*;

/// A `thread.archive` at `before`.
fn archive(before: i64) -> String {
    format!(
        r#"{{"id":"archive","deviceId":"device","payload":{{"type":"thread.archive","threadId":"t","beforeSeq":{before}}}}}"#
    )
}

#[test]
fn an_archive_is_refused_once_anything_that_could_be_work_happened_after_the_decision() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.exec(
        "INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (2, 'e2', 't', 2, 'item.delta', '{}')",
    );
    // Its own output is not work the person didn't see.
    let archived = receipt.handle(&archive(1));
    assert_eq!(archived.get("ok").and_then(Value::as_bool), Some(true));
    assert!(
        receipt
            .shell
            .written_types("t")
            .iter()
            .any(|kind| kind == "thread.updated"),
        "the archive event is written"
    );

    let receipt = Receipt::new(LimitOverrides::default());
    receipt.exec(
        "INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (2, 'e2', 't', 2, 'run.started', '{\"run\":{\"agentId\":\"agent-1\"}}')",
    );
    assert_eq!(
        receipt.handle(&archive(1)),
        result("archive", "thread_changed")
    );
    assert!(
        receipt.shell.written_types("t").is_empty(),
        "nothing is archived"
    );
}

#[test]
fn a_child_threads_new_work_refuses_the_archive_too() {
    let receipt = Receipt::new(LimitOverrides::default());
    // The parent's state names a delegated child on this machine.
    receipt.exec(
        "UPDATE thread_state SET state = json_set(state, '$.rootKey', 'root', '$.agents', json('{\"ace-child:child\":{\"agent\":{\"id\":\"agent-child\",\"threadId\":\"t\",\"parentId\":null,\"origin\":\"ace\",\"native\":{\"provider\":\"codex\"},\"status\":{\"state\":\"idle\"},\"fidelity\":\"summary\",\"cwd\":\"/tmp\",\"background\":false,\"createdAt\":1,\"childThreadId\":\"child\"},\"activity\":\"idle\",\"lastSignalAt\":1}}')), seq = seq + 1 WHERE thread_id='t'",
    );
    receipt.exec(
        "INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (2, 'e2', 'child', 2, 'run.started', '{}')",
    );
    assert_eq!(
        receipt.handle(&archive(1)),
        result("archive", "thread_changed")
    );
    // Its own older events do not refuse.
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.exec(
        "UPDATE thread_state SET state = json_set(state, '$.rootKey', 'root', '$.agents', json('{\"ace-child:child\":{\"agent\":{\"id\":\"agent-child\",\"threadId\":\"t\",\"parentId\":null,\"origin\":\"ace\",\"native\":{\"provider\":\"codex\"},\"status\":{\"state\":\"idle\"},\"fidelity\":\"summary\",\"cwd\":\"/tmp\",\"background\":false,\"createdAt\":1,\"childThreadId\":\"child\"},\"activity\":\"idle\",\"lastSignalAt\":1}}')), seq = seq + 1 WHERE thread_id='t'",
    );
    receipt.exec(
        "INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (1, 'e1', 'child', 1, 'run.started', '{}')",
    );
    assert_eq!(
        receipt
            .handle(&archive(1))
            .get("ok")
            .and_then(Value::as_bool),
        Some(true)
    );
}
