// SPDX-License-Identifier: Apache-2.0
//! The host's storage acknowledgements through the session (`host.ts:146`-`:189`): a request is
//! answered after every distinct frame it carried was reported, and a repeated report for one
//! frame never releases the host before the rest are stored.

use super::*;

/// The replies and notices the core wrote, as text.
fn writes(effects: &[CoreEffect]) -> Vec<String> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            CoreEffect::Write { wire, .. } => std::str::from_utf8(wire).ok().map(str::to_owned),
            _ => None,
        })
        .collect()
}

fn batch(frames: &[String]) -> String {
    format!(
        r#"{{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"batch","body":{{"frames":[{}]}}}}"#,
        frames.join(",")
    )
}

#[test]
fn a_duplicate_acknowledgement_does_not_release_the_host_before_the_batch_is_stored() {
    let mut core = session_core();
    opened(&mut core);
    let params = batch(&[
        envelope("delta", "op", 0.0, r#"{"type":"text-delta","text":"a"}"#),
        envelope("delta", "op", 0.0, r#"{"type":"text-delta","text":"b"}"#),
    ]);
    let effects = feed(
        &mut core,
        &format!(r#"{{"jsonrpc":"2.0","id":"h","method":"frame","params":{params}}}"#),
    );
    let seqs: Vec<u64> = frames(&effects).iter().map(|(seq, _, _)| *seq).collect();
    assert_eq!(seqs, vec![1, 2]);
    // One frame stored, twice reported: the request still waits on the other frame.
    assert!(writes(&core.committed(1)).is_empty());
    assert!(
        writes(&core.committed(1)).is_empty(),
        "a duplicate report answered the host before its second frame was stored"
    );
    let answered = writes(&core.committed(2));
    assert_eq!(answered.len(), 1);
    assert!(answered[0].contains(r#""result":{"committed":true}"#));
}
