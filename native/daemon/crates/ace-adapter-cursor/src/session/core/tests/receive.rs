// SPDX-License-Identifier: Apache-2.0
//! The frame the session hands over and the turn it reads (`session.ts:105`-`:139`).

use super::*;

#[test]
fn a_frame_starting_at_one_acknowledges_the_host_frame_it_carries() {
    let mut core = session_core();
    let line = frame_line(&envelope(
        "delta",
        "open",
        0.0,
        r#"{"type":"text-delta","text":"a"}"#,
    ));
    let effects = core.stdout_bytes(format!("{line}\n").as_bytes());
    let frame = effects
        .iter()
        .find_map(|effect| match effect {
            CoreEffect::Event(SessionEvent::Frame { seq, dir, text, .. }) => {
                Some((*seq, *dir, text.clone()))
            }
            _ => None,
        })
        .expect("a frame");
    assert_eq!(frame.0, 1);
    assert_eq!(frame.1, FrameDirection::Recv);
    assert!(frame.2.contains(r#""kind":"delta""#));
    // The acknowledgement names the session's number; the host hears its own.
    let effects = core.committed(1);
    assert!(effects.iter().any(|effect| matches!(
        effect,
        CoreEffect::Write { wire, .. }
            if String::from_utf8_lossy(wire).contains(r#""result":{"committed":true}"#)
    )));
}
