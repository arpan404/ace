// SPDX-License-Identifier: Apache-2.0
use crate::relay::Transport as RelayStream;
use crate::{CipherState, FlowCredit, Fragment, FragmentKind, Fragments, read_credit};
use media_wire::keys::KeyBlock;
use serde_json::Value;
use zeroize::Zeroizing;
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
pub(crate) fn bytes(v: &Value) -> Result<Vec<u8>> {
    let hex = v["hex"].as_str().ok_or("hex")?;
    (0..hex.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&hex[i..i + 2], 16)?))
        .collect()
}
pub(crate) fn key(v: &Value) -> Result<Zeroizing<[u8; 32]>> {
    Ok(Zeroizing::new(
        bytes(v)?.try_into().map_err(|_| "key size")?,
    ))
}
fn block(k: &Value, nonce: u64, frames: u64) -> Result<Zeroizing<Vec<u8>>> {
    let b = KeyBlock {
        send_key: key(k)?,
        receive_key: key(k)?,
        send_nonce: nonce,
        receive_nonce: nonce,
        frames_sent: frames,
        frames_received: frames,
        flags: 0,
        window: 0,
        unacked: 0,
        owed: 0,
        uncounted: 0,
    };
    Ok(Zeroizing::new(b.encode().map_err(|_| "block")?.to_vec()))
}
#[test]
fn ts_ciphertext_and_decryption_match_across_two_rekeys() -> Result {
    let v: Value = serde_json::from_str(include_str!("../../../vectors/noise/scenarios.json"))?;
    let n = v["initialNonce"].as_str().ok_or("nonce")?.parse()?;
    let mut stream = RelayStream::<16>::import(block(&v["key"], n, 0)?)?;
    for step in v["steps"].as_array().ok_or("steps")? {
        assert_eq!(
            stream.seal(&bytes(&step["plain"])?)?,
            bytes(&step["sealed"])?
        );
        assert_eq!(
            *stream.open(&bytes(&step["sealed"])?)?,
            bytes(&step["opened"])?
        );
    }
    Ok(())
}
#[test]
fn in_place_seal_and_open_in_one_reused_buffer_match_ts_transcript_across_rekeys() -> Result {
    let v: Value = serde_json::from_str(include_str!("../../../vectors/noise/scenarios.json"))?;
    let n = v["initialNonce"].as_str().ok_or("nonce")?.parse()?;
    let mut stream = RelayStream::<16>::import(block(&v["key"], n, 0)?)?;
    let mut buffer = Zeroizing::new(Vec::new());
    for step in v["steps"].as_array().ok_or("steps")? {
        let plain = bytes(&step["plain"])?;
        buffer.clear();
        buffer.extend_from_slice(&plain);
        stream.seal_in_place(&mut buffer)?;
        assert_eq!(*buffer, bytes(&step["sealed"])?);
        assert_eq!(
            stream.open_in_place(&mut buffer)?,
            &bytes(&step["opened"])?[..]
        );
    }
    Ok(())
}
#[test]
fn fragments_written_into_a_reused_buffer_equal_the_allocating_iterator() -> Result {
    let data: Vec<u8> = (0..150_000_u32).map(|i| i as u8).collect();
    let expected: Vec<_> = Fragments::new(&data, FragmentKind::Json)?.collect();
    let mut fragments = Fragments::new(&data, FragmentKind::Json)?;
    let mut buffer = Vec::new();
    let mut seen = 0;
    while fragments.next_into(&mut buffer) {
        assert_eq!(buffer, *expected[seen]);
        assert!(buffer.capacity() >= buffer.len() + 16);
        seen += 1;
    }
    assert_eq!(seen, expected.len());
    assert_eq!(seen, 3);
    Ok(())
}
#[test]
fn handover_resumes_ts_nonces_and_frame_counts_at_production_rekey() -> Result {
    let v: Value = serde_json::from_str(include_str!("../../../vectors/noise/scenarios.json"))?;
    // TS transcript frames 15 and 16 straddle rekey; align that boundary to production's.
    let steps = v["steps"].as_array().ok_or("steps")?;
    let mut stream =
        RelayStream::<{ 1 << 20 }>::import(block(&v["key"], (1 << 32) + 15, (1 << 20) - 1)?)?;
    for step in &steps[15..17] {
        assert_eq!(
            stream.seal(&bytes(&step["plain"])?)?,
            bytes(&step["sealed"])?
        );
        assert_eq!(
            *stream.open(&bytes(&step["sealed"])?)?,
            bytes(&step["opened"])?
        );
    }
    Ok(())
}
#[test]
fn ts_flow_credit_transcript_returns_identical_credit_bytes() -> Result {
    let v: Value =
        serde_json::from_str(include_str!("../../../vectors/flow-credit/scenarios.json"))?;
    let mut flow = FlowCredit::default();
    assert_eq!(flow.start().ok_or("start")?.to_vec(), bytes(&v["start"])?);
    flow.credited(0)?;
    for step in v["steps"].as_array().ok_or("steps")? {
        let cost = step["input"]["cost"].as_u64().ok_or("cost")? as usize;
        let out = &step["output"];
        assert_eq!(
            flow.allows(cost),
            out["allowed"].as_bool().ok_or("allowed")?
        );
        if flow.allows(cost) {
            flow.spend(cost)?;
        }
        assert_eq!(
            flow.received(cost),
            out["accepted"].as_bool().ok_or("accepted")?
        );
        let credit = flow.consumed(cost)?;
        if let Some(credit) = credit {
            assert_eq!(credit.to_vec(), bytes(&out["credit"])?);
            flow.credited(read_credit(&credit)?)?;
        } else {
            assert!(out.get("credit").is_none());
        }
        assert_eq!(flow.limited(), out["limited"].as_bool().ok_or("limited")?);
        assert_eq!(
            flow.counting(),
            out["counting"].as_bool().ok_or("counting")?
        );
    }
    Ok(())
}
#[test]
fn recorded_relay_frames_include_fragment_boundaries_and_credits() -> Result {
    let v: Value =
        serde_json::from_str(include_str!("../../../vectors/fragmenting/scenarios.json"))?;
    let mut left = RelayStream::<16>::import(block(&v["key"], 0, 0)?)?;
    let mut right = RelayStream::<16>::import(block(&v["key"], 0, 0)?)?;
    let mut sent = Vec::new();
    for input in v["inputs"].as_array().ok_or("inputs")? {
        let data = vec![
            input["byte"].as_u64().ok_or("byte")? as u8;
            input["length"].as_u64().ok_or("length")? as usize
        ];
        for plain in Fragments::new(&data, FragmentKind::Binary)? {
            sent.push(plain);
        }
    }
    let mut data_index = 0;
    let mut joined = Vec::new();
    let mut messages = Vec::new();
    for frame in v["frames"].as_array().ok_or("frames")? {
        let sealed = bytes(&frame["sealed"])?;
        let stream = if frame["direction"] == "send" {
            &mut left
        } else {
            &mut right
        };
        let plain = stream.open(&sealed)?;
        assert_eq!(stream.seal(&plain)?, sealed);
        if plain[0] == 7 {
            read_credit(&plain)?;
            continue;
        }
        let f = Fragment::decode(&plain)?;
        if frame["direction"] == "send" {
            assert_eq!(*plain, *sent[data_index]);
            data_index += 1;
            joined.extend_from_slice(f.data);
            if f.last {
                messages.push(std::mem::take(&mut joined));
            }
        } else {
            assert_eq!(f.data, [9, 8, 7]);
        }
    }
    assert_eq!(data_index, sent.len());
    let opened = v["opened"].as_array().ok_or("opened")?;
    for (actual, expected) in messages.iter().zip(opened) {
        assert_eq!(*actual, bytes(expected)?);
    }
    Ok(())
}
#[test]
fn authentication_failure_preserves_cipher_nonce_but_closes_relay() -> Result {
    let mut sender = CipherState::new(Zeroizing::new([1; 32]), 7)?;
    let mut receiver = CipherState::new(Zeroizing::new([1; 32]), 7)?;
    let frame = sender.encrypt(b"test", b"ad")?;
    assert!(receiver.decrypt(&frame, b"wrong").is_err());
    assert_eq!(&**receiver.decrypt(&frame, b"ad")?, b"test");
    assert!(receiver.decrypt(&frame, b"ad").is_err());
    let mut exhausted = CipherState::new(Zeroizing::new([1; 32]), u64::MAX)?;
    assert!(exhausted.encrypt(b"x", &[]).is_err());
    assert!(exhausted.rekey().is_err());
    Ok(())
}

#[test]
fn malformed_flow_and_key_blocks_are_refused_before_use() -> Result {
    let k = serde_json::json!({"hex": "01".repeat(32)});
    for (flags, window, unacked, owed, uncounted) in [
        (0, 1, 0, 0, 0),
        (3, 1048577, 0, 0, 0),
        (3, 10, 0, 1, 0),
        (3, 10, 4096, 0, 0),
        (3, 10, 0, 0, 1),
        (2, 0, 0, 0, 0),
    ] {
        let original = block(&k, 1, 1)?;
        let mut b = KeyBlock::decode(&original).map_err(|_| "decode")?;
        b.flags = flags;
        b.window = window;
        b.unacked = unacked;
        b.owed = owed;
        b.uncounted = uncounted;
        assert!(
            RelayStream::<16>::import(Zeroizing::new(b.encode().map_err(|_| "encode")?.to_vec()))
                .is_err()
        );
    }
    let mut corrupt = block(&k, 1, 1)?;
    corrupt[0] ^= 1;
    assert!(RelayStream::<16>::import(corrupt).is_err());
    assert!(RelayStream::<16>::import(Zeroizing::new(vec![0; 119])).is_err());
    Ok(())
}
#[test]
fn imported_credit_window_and_owed_credit_continue_exactly() -> Result {
    let k = serde_json::json!({"hex": "01".repeat(32)});
    let payload = block(&k, 1, 1)?;
    let mut b = KeyBlock::decode(&payload).map_err(|_| "decode")?;
    b.flags = 3;
    b.window = 4096;
    b.unacked = 258048;
    b.owed = 258048;
    let mut stream =
        RelayStream::<16>::import(Zeroizing::new(b.encode().map_err(|_| "encode")?.to_vec()))?;
    assert!(stream.flow.start().is_none());
    assert!(!stream.flow.allows(4097));
    stream.flow.spend(4096)?;
    assert!(!stream.flow.allows(1));
    assert!(stream.flow.received(4096));
    assert_eq!(
        stream.flow.consumed(4096)?,
        Some(crate::credit_fragment(262144))
    );
    Ok(())
}
#[test]
fn credits_do_not_charge_data_window_and_pre_start_data_is_not_credited() -> Result {
    let mut flow = FlowCredit::default();
    assert!(flow.received(65519));
    flow.credited(0)?;
    assert_eq!(flow.consumed(65519)?, None);
    for _ in 0..256 {
        flow.spend(4096)?;
        assert!(flow.received(4096));
    }
    assert!(flow.spend(4096).is_err());
    assert!(!flow.received(4096));
    for bad in [&[7][..], &[6, 0, 0, 0, 0], &[7, 0, 16, 0, 1]] {
        assert!(read_credit(bad).is_err());
    }
    Ok(())
}
#[test]
fn fragments_reassemble_at_wire_limit_and_reject_mixed_or_oversized_messages() -> Result {
    use crate::MessageAssembler;
    for kind in [
        FragmentKind::Json,
        FragmentKind::Binary,
        FragmentKind::Deflated,
    ] {
        let data = vec![42; 65520];
        let mut join = MessageAssembler::default();
        let fragments: Vec<_> = Fragments::new(&data, kind)?.collect();
        assert_eq!(fragments[0].len(), 65519);
        assert!(join.push(&fragments[0])?.is_none());
        let message = join.push(&fragments[1])?.ok_or("message")?;
        assert_eq!(message.kind, kind);
        assert_eq!(*message.data, data);
        assert!(join.push(&fragments[0])?.is_none());
        let mut wrong = fragments[1].to_vec();
        wrong[0] = ((kind as u8 + 2) % 6) + 1;
        assert!(join.push(&wrong).is_err());
    }
    let mut join = MessageAssembler::default();
    assert!(join.push(&[2, 1]).is_err());
    assert!(join.push(&[3]).is_err());
    assert!(join.push(&[6, 1]).is_err());
    assert!(join.push(&vec![2; 65519])?.is_none());
    assert!(join.push(&[3; 36]).is_err());
    Ok(())
}
#[test]
fn relay_authentication_failure_closes_both_directions() -> Result {
    let k = serde_json::json!({"hex": "01".repeat(32)});
    let mut stream = RelayStream::<16>::import(block(&k, 1, 1)?)?;
    assert!(stream.open(&[0; 16]).is_err());
    assert!(stream.seal(&[3, 1]).is_err());
    Ok(())
}

#[test]
fn panic_hook_redacts_payload() -> Result {
    if std::env::var_os("ACE_MEDIA_TEST_PANIC").is_some() {
        crate::install_payload_free_panic_hook();
        panic!("secret-payload-must-not-appear");
    }
    let out = std::process::Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "tests::panic_hook_redacts_payload",
            "--nocapture",
        ])
        .env("ACE_MEDIA_TEST_PANIC", "1")
        .output()?;
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("ace-media: panic"));
    for output in [&out.stdout, &out.stderr] {
        assert!(!String::from_utf8_lossy(output).contains("secret-payload-must-not-appear"));
    }
    Ok(())
}

#[test]
fn cost_floor_bounds_small_fragment_count_and_oversize_does_not_spend_nonce() -> Result {
    assert_eq!(crate::fragment_cost(0), 4096);
    assert_eq!(crate::fragment_cost(4096), 4096);
    assert_eq!(crate::fragment_cost(65519), 65519);
    let mut cipher = CipherState::new(Zeroizing::new([1; 32]), 0)?;
    assert!(cipher.encrypt(&vec![0; 65520], &[]).is_err());
    let mut peer = CipherState::new(Zeroizing::new([1; 32]), 0)?;
    let frame = cipher.encrypt(&vec![7; 65519], &[])?;
    assert_eq!(frame.len(), 65535);
    assert_eq!(*peer.decrypt(&frame, &[])?, vec![7; 65519]);
    Ok(())
}
