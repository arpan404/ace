// SPDX-License-Identifier: Apache-2.0
//! Checkpoint metadata and identity (`checkpoint-metadata.ts`). The malformed commit-list cases
//! move from `malformed-output.test.ts` (guide rule 10); the identity and metadata rules are
//! asserted where the TypeScript words them.

use super::{
    CHECKPOINT_FORMAT, checkpoint, checkpoint_identity, checkpoint_prefix, metadata,
    metadata_message, parse_commits,
};
use crate::core::error::GitErrorCode;

const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TREE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CREATED: &str = "2026-11-26T09:00:00.000Z";
const ID: &str = "refs/ace/checkpoints/thread-1/3";

fn message(sequence: Option<u64>) -> String {
    match sequence {
        Some(sequence) => metadata_message("thread-1", "before edit", CREATED, sequence),
        None => format!(
            r#"{{"format":"{CHECKPOINT_FORMAT}","threadId":"thread-1","label":"before edit","createdAt":"{CREATED}"}}"#
        ),
    }
}

fn commit_record(sha: &str, tree: &str, message: &str) -> String {
    format!("{sha}\0{tree}\0{message}\0")
}

fn malformed_code(error: crate::core::error::GitError) -> GitErrorCode {
    error.code
}

#[test]
fn a_thread_id_names_its_ref_namespace_or_is_refused() {
    assert_eq!(
        checkpoint_prefix("thread-1_A").as_deref(),
        Ok("refs/ace/checkpoints/thread-1_A/")
    );
    for bad in ["", "thread/1", "thread 1", "thr.ead", "thr:ead"] {
        assert_eq!(
            checkpoint_prefix(bad).expect_err("refused").code,
            GitErrorCode::InvalidArgument,
            "{bad}"
        );
    }
}

#[test]
fn a_checkpoint_id_carries_its_thread_and_a_positive_sequence() {
    assert_eq!(checkpoint_identity(ID), Ok((String::from("thread-1"), 3)));
    for bad in [
        "",
        "refs/ace/checkpoints/thread-1/0",
        "refs/ace/checkpoints/thread-1/01",
        "refs/ace/checkpoints/thread-1/-1",
        "refs/ace/checkpoints//3",
        "refs/ace/checkpoints/thread-1",
        "refs/heads/main",
        "refs/ace/checkpoints/thread-1/3/4",
    ] {
        assert_eq!(
            checkpoint_identity(bad).expect_err("refused").code,
            GitErrorCode::CheckpointNotFound,
            "{bad}"
        );
    }
    // A sequence beyond the safe range is not an id (`Number` rounds it to a non-safe value).
    let huge = format!("refs/ace/checkpoints/thread-1/{}", "9".repeat(20));
    assert_eq!(
        checkpoint_identity(&huge).expect_err("refused").code,
        GitErrorCode::CheckpointNotFound
    );
}

#[test]
fn the_message_round_trips_through_the_metadata_check() {
    let text = message(Some(7));
    let parsed = metadata(&text).expect("metadata");
    assert_eq!(parsed.thread_id, "thread-1");
    assert_eq!(parsed.label, "before edit");
    assert_eq!(parsed.created_at, CREATED);
    assert_eq!(parsed.sequence, Some(7));
    // A message written before durable counters has no sequence.
    assert_eq!(metadata(&message(None)).expect("metadata").sequence, None);
}

#[test]
fn metadata_is_refused_exactly_where_the_schema_refuses_it() {
    let cases = [
        (
            r#"{"format":"other","threadId":"t","label":"l","createdAt":"2026-11-26T09:00:00Z"}"#,
            "format",
        ),
        (
            r#"{"format":"ace-checkpoint-v1","threadId":"a/b","label":"l","createdAt":"2026-11-26T09:00:00Z"}"#,
            "thread id",
        ),
        (
            r#"{"format":"ace-checkpoint-v1","threadId":"t","createdAt":"2026-11-26T09:00:00Z"}"#,
            "label",
        ),
        (
            r#"{"format":"ace-checkpoint-v1","threadId":"t","label":"l","createdAt":"yesterday"}"#,
            "timestamp",
        ),
        (
            r#"{"format":"ace-checkpoint-v1","threadId":"t","label":"l","createdAt":"2026-02-30T09:00:00Z"}"#,
            "calendar",
        ),
        (
            r#"{"format":"ace-checkpoint-v1","threadId":"t","label":"l","createdAt":"2026-11-26T09:00:00"}"#,
            "no offset",
        ),
        (
            r#"{"format":"ace-checkpoint-v1","threadId":"t","label":"l","createdAt":"2026-11-26T09:00:00Z","sequence":0}"#,
            "sequence",
        ),
        (
            r#"{"format":"ace-checkpoint-v1","threadId":"t","label":"l","createdAt":"2026-11-26T09:00:00Z","sequence":1.5}"#,
            "fraction",
        ),
        (
            r#"{"format":"ace-checkpoint-v1","threadId":"t","label":"l","createdAt":"2026-11-26T09:00:00Z","sequence":"1"}"#,
            "text sequence",
        ),
        ("[]", "not an object"),
        ("not json", "not JSON"),
    ];
    for (text, name) in cases {
        assert_eq!(
            metadata(text).expect_err("refused").code,
            GitErrorCode::MalformedOutput,
            "{name}"
        );
    }
    // A fractional second and a numeric offset are ISO date-times.
    assert!(
        metadata(&format!(
            r#"{{"format":"{CHECKPOINT_FORMAT}","threadId":"t","label":"l","createdAt":"2026-11-26T09:00:00.123456+05:30"}}"#
        ))
        .is_ok()
    );
}

#[test]
fn a_commit_list_is_one_sha_tree_and_message_per_commit() {
    let output = commit_record(SHA, TREE, &message(Some(1)));
    let commits = parse_commits(output.as_bytes()).expect("parsed");
    assert_eq!(commits.len(), 1);
    let commit = commits.get(SHA).expect("sha");
    assert_eq!(commit.tree, TREE);
    assert_eq!(commit.data.label, "before edit");
    // Two commits, in the order Git printed them.
    let output = format!(
        "{}{}",
        commit_record(SHA, TREE, &message(Some(1))),
        commit_record(
            "cccccccccccccccccccccccccccccccccccccccc",
            TREE,
            &message(Some(2))
        )
    );
    let commits = parse_commits(output.as_bytes()).expect("parsed");
    assert_eq!(
        commits.keys().cloned().collect::<Vec<_>>(),
        [
            String::from(SHA),
            String::from("cccccccccccccccccccccccccccccccccccccccc")
        ]
    );
}

#[test]
fn a_commit_list_refuses_what_it_cannot_read() {
    // The four cases `malformed-output.test.ts` names for `parseCommits`.
    let cases = [
        ("commit arity", format!("{SHA}\0")),
        ("commit tree", format!("{SHA}\0abc\0{}\0", message(Some(1)))),
        ("metadata JSON", format!("{SHA}\0{TREE}\0not json\0")),
        (
            "metadata timestamp",
            format!(
                r#"{SHA}\0{TREE}\0{{"format":"ace-checkpoint-v1","threadId":"bad","label":"bad","createdAt":"yesterday"}}\0"#
            ),
        ),
        (
            "duplicate commit record",
            format!(
                "{}{}",
                commit_record(SHA, TREE, &message(Some(1))),
                commit_record(SHA, TREE, &message(Some(1)))
            ),
        ),
        (
            "tree hash",
            commit_record(SHA, "not-a-hash", &message(Some(1))),
        ),
    ];
    for (name, output) in cases {
        assert_eq!(
            malformed_code(parse_commits(output.as_bytes()).expect_err("refused")),
            GitErrorCode::MalformedOutput,
            "{name}"
        );
    }
}

#[test]
fn a_checkpoint_must_agree_with_its_id() {
    let commits =
        parse_commits(commit_record(SHA, TREE, &message(Some(3))).as_bytes()).expect("parsed");
    let commit = commits.get(SHA).expect("sha");
    let record = checkpoint(ID, commit).expect("checkpoint");
    assert_eq!(record.id, ID);
    assert_eq!(record.tree, TREE);
    assert_eq!(record.thread_id, "thread-1");
    assert_eq!(record.sequence, 3);
    assert_eq!(record.label, "before edit");
    assert_eq!(record.created_at, CREATED);
    // The id's sequence and the metadata's must agree when the metadata names one.
    let other = "refs/ace/checkpoints/thread-1/4";
    assert_eq!(
        malformed_code(checkpoint(other, commit).expect_err("refused")),
        GitErrorCode::MalformedOutput
    );
    // A message with no sequence takes the id's.
    let commits =
        parse_commits(commit_record(SHA, TREE, &message(None)).as_bytes()).expect("parsed");
    assert_eq!(
        checkpoint(ID, commits.get(SHA).expect("sha"))
            .expect("checkpoint")
            .sequence,
        3
    );
    // A different thread is not this id's checkpoint.
    let foreign = "refs/ace/checkpoints/thread-2/3";
    assert_eq!(
        malformed_code(checkpoint(foreign, commit).expect_err("refused")),
        GitErrorCode::MalformedOutput
    );
}
