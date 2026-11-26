//! Ports `packages/secure-channel/src/noise.test.ts`'s cipher cases (the rekey vector, the
//! reserved nonce, the sizes, the ordered replay and the snapshot) and the `cipher.ts` key
//! hand-over, then replays the committed media vectors the daemon and the browser both run:
//! `native/media/vectors/noise` and `noise-handover`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use ace_json::Value;

use super::{CipherState, MAX_MESSAGE, Snapshot};

fn hex(text: &str) -> Vec<u8> {
    data_encoding::HEXLOWER_PERMISSIVE
        .decode(text.as_bytes())
        .unwrap()
}

fn as_hex(bytes: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(bytes)
}

fn vector(area: &str) -> Value {
    let text = match area {
        "noise" => include_str!("../../../../../../native/media/vectors/noise/scenarios.json"),
        _ => include_str!("../../../../../../native/media/vectors/noise-handover/scenarios.json"),
    };
    ace_json::parse(text).unwrap()
}

fn steps(vector: &Value) -> Vec<Value> {
    vector
        .get("steps")
        .and_then(Value::as_array)
        .unwrap()
        .to_vec()
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn hex_field(value: &Value, key: &str) -> Vec<u8> {
    hex(field(value.get(key).unwrap(), "hex"))
}

fn key_of(value: &Value) -> [u8; 32] {
    hex_field(value, "key").try_into().unwrap()
}

#[test]
fn the_committed_noise_media_vector_replays_message_for_message() {
    let vector = vector("noise");
    let key = key_of(&vector);
    let initial: u64 = field(&vector, "initialNonce").parse().unwrap();
    let mut sender = CipherState::new(Some(key), initial);
    let mut receiver = CipherState::new(Some(key), initial);
    for step in steps(&vector) {
        let plain = hex_field(&step, "plain");
        let sealed = sender.encrypt(&plain, &[]).unwrap();
        assert_eq!(as_hex(&sealed), field(step.get("sealed").unwrap(), "hex"));
        let opened = receiver.decrypt(&sealed, &[]).unwrap();
        assert_eq!(opened, plain);
        assert_eq!(as_hex(&opened), field(step.get("opened").unwrap(), "hex"));
        if step.get("rekey").and_then(Value::as_bool) == Some(true) {
            sender.rekey().unwrap();
            receiver.rekey().unwrap();
        }
    }
}

#[test]
fn the_committed_handover_media_vector_replays_both_directions_with_their_own_rekeys() {
    let vector = vector("noise-handover");
    let send = vector.get("send").unwrap();
    let receive = vector.get("receive").unwrap();
    let nonce = |side: &Value| field(side, "nonce").parse::<u64>().unwrap();
    let mut ciphers = [
        CipherState::new(Some(key_of(send)), nonce(send)),
        CipherState::new(Some(key_of(receive)), nonce(receive)),
    ];
    let mut frames = [
        field(send, "frames").parse::<u64>().unwrap(),
        field(receive, "frames").parse::<u64>().unwrap(),
    ];
    let interval = vector.get("rekeyInterval").and_then(Value::as_u64).unwrap();
    for step in steps(&vector) {
        let direction = usize::from(field(&step, "direction") == "receive");
        let plain = hex_field(&step, "plain");
        let event = &step;
        let sealed = ciphers[direction].encrypt(&plain, &[]).unwrap();
        assert_eq!(
            as_hex(&sealed),
            field(event.get("sealed").unwrap(), "hex"),
            "step {}",
            field(event, "index")
        );
        frames[direction] += 1;
        if frames[direction] % interval == 0 {
            ciphers[direction].rekey().unwrap();
            assert_eq!(event.get("rekey").and_then(Value::as_bool), Some(true));
        }
    }
}

#[test]
fn a_rekey_s_sealed_bytes_are_the_chacha_reference() {
    // Native Node/OpenSSL reference: key 07 repeated, rekey after one send, payload 02 at
    // nonce 1 (`noise.test.ts:102`).
    let key = [7u8; 32];
    let mut sender = CipherState::keyed(key);
    let mut receiver = CipherState::keyed(key);
    let mut old = CipherState::keyed(key);
    receiver
        .decrypt(&sender.encrypt(&[1], &[]).unwrap(), &[])
        .unwrap();
    old.decrypt(&CipherState::keyed(key).encrypt(&[1], &[]).unwrap(), &[])
        .unwrap();
    sender.rekey().unwrap();
    receiver.rekey().unwrap();
    let message = sender.encrypt(&[2], &[]).unwrap();
    assert_eq!(as_hex(&message), "acc100689abe3692f6d7cccfd594fc119c");
    assert!(old.decrypt(&message, &[]).is_err());
    assert_eq!(receiver.decrypt(&message, &[]).unwrap(), vec![2]);
}

#[test]
fn tampered_replayed_and_reordered_messages_do_not_advance_the_receive_nonce() {
    let key = [9u8; 32];
    let mut sender = CipherState::keyed(key);
    let mut receiver = CipherState::keyed(key);
    let first = sender.encrypt(&[1], &[]).unwrap();
    let second = sender.encrypt(&[2], &[]).unwrap();
    let mut corrupt = first.clone();
    corrupt[0] ^= 1;
    assert!(receiver.decrypt(&corrupt, &[]).is_err());
    assert!(receiver.decrypt(&second, &[]).is_err());
    assert_eq!(receiver.decrypt(&first, &[]).unwrap(), vec![1]);
    assert!(receiver.decrypt(&first, &[]).is_err());
    assert_eq!(receiver.decrypt(&second, &[]).unwrap(), vec![2]);
}

#[test]
fn the_largest_message_is_taken_and_one_byte_more_is_refused() {
    let key = [1u8; 32];
    let mut sender = CipherState::keyed(key);
    let mut receiver = CipherState::keyed(key);
    let message = sender.encrypt(&vec![7u8; MAX_MESSAGE - 16], &[]).unwrap();
    assert_eq!(message.len(), MAX_MESSAGE);
    assert_eq!(
        receiver.decrypt(&message, &[]).unwrap().len(),
        MAX_MESSAGE - 16
    );
    assert!(sender.encrypt(&vec![7u8; MAX_MESSAGE - 15], &[]).is_err());
    assert!(receiver.decrypt(&vec![7u8; MAX_MESSAGE + 1], &[]).is_err());
}

#[test]
fn the_last_permitted_nonce_works_once_and_the_reserved_one_exhausts_both() {
    let last = u64::MAX - 1;
    let key = [7u8; 32];
    let mut sender = CipherState::new(Some(key), last);
    let mut receiver = CipherState::new(Some(key), last);
    let sealed = sender.encrypt(&[42], &[]).unwrap();
    assert_eq!(receiver.decrypt(&sealed, &[]).unwrap(), vec![42]);
    assert!(sender.encrypt(&[43], &[]).is_err());
    assert!(receiver.decrypt(&sealed, &[]).is_err());
    assert!(sender.rekey().is_err());
    assert!(receiver.rekey().is_err());
}

#[test]
fn a_snapshot_resumes_the_same_ordered_session() {
    let key = [3u8; 32];
    let mut sender = CipherState::keyed(key);
    let mut receiver = CipherState::keyed(key);
    receiver
        .decrypt(&sender.encrypt(b"first", &[]).unwrap(), &[])
        .unwrap();
    let Snapshot {
        key: saved_key,
        nonce,
    } = receiver.snapshot().unwrap();
    receiver.destroy();
    assert!(receiver.snapshot().is_err());
    let mut resumed = CipherState::new(Some(saved_key), nonce);
    assert_eq!(
        resumed
            .decrypt(&sender.encrypt(b"second", &[]).unwrap(), &[])
            .unwrap(),
        b"second"
    );
    let replay = sender.encrypt(b"third", &[]).unwrap();
    assert_eq!(resumed.decrypt(&replay, &[]).unwrap(), b"third");
    assert!(resumed.decrypt(&replay, &[]).is_err());
    // A keyless state has nothing to hand over.
    assert!(CipherState::new(None, 0).snapshot().is_err());
}

#[test]
fn a_handover_writes_the_key_and_a_big_endian_nonce_and_then_destroys_the_state() {
    let key = [5u8; 32];
    let mut state = CipherState::new(Some(key), 0x1_0000_0007);
    let mut block = vec![0u8; 64];
    state.export_into(&mut block, 0, 40).unwrap();
    assert_eq!(&block[..32], &key);
    assert_eq!(
        u64::from_be_bytes(block[40..48].try_into().unwrap()),
        0x1_0000_0007
    );
    assert!(!state.has_key());
    // Outside the block, or overlapping ranges, is refused before anything is written.
    let mut state = CipherState::keyed(key);
    let mut small = vec![0u8; 32];
    assert_eq!(
        state
            .export_into(&mut small, 8, 32)
            .unwrap_err()
            .to_string(),
        "Export outside the block"
    );
    let mut block = vec![0u8; 64];
    assert_eq!(
        state
            .export_into(&mut block, 0, 28)
            .unwrap_err()
            .to_string(),
        "Key and nonce ranges overlap"
    );
    assert!(block.iter().all(|byte| *byte == 0) && small.iter().all(|byte| *byte == 0));
}
