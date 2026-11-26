//! Ports `packages/secure-channel/src/noise.test.ts`, `noise-nk.test.ts` and
//! `noise-nk-vectors.test.ts` against the official fixtures in `tests/fixtures/`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use ace_json::Value;

use super::{Ephemeral, KeyPair, MAX_MESSAGE, NK_FIRST_MESSAGE_MINIMUM, NoiseNk, NoiseXx, host_id};

const CACOPHONY: &str = include_str!("../../tests/fixtures/cacophony.json");
const SNOW: &str = include_str!("../../tests/fixtures/snow.json");
const NK: &str = include_str!("../../tests/fixtures/nk.json");

fn hex(text: &str) -> Vec<u8> {
    data_encoding::HEXLOWER_PERMISSIVE
        .decode(text.as_bytes())
        .unwrap()
}

fn as_hex(bytes: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(bytes)
}

fn vectors(fixture: &str) -> Vec<Value> {
    let parsed = ace_json::parse(fixture).unwrap();
    parsed
        .get("vectors")
        .and_then(Value::as_array)
        .unwrap()
        .to_vec()
}

fn field<'a>(vector: &'a Value, key: &str) -> &'a str {
    vector.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn messages(vector: &Value) -> Vec<(Vec<u8>, Vec<u8>)> {
    vector
        .get("messages")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|message| {
            (
                hex(message.get("payload").and_then(Value::as_str).unwrap_or("")),
                hex(message.get("ciphertext").and_then(Value::as_str).unwrap()),
            )
        })
        .collect()
}

#[test]
fn official_noise_xx_vectors_match_every_handshake_and_transport_byte() {
    for fixture in [CACOPHONY, SNOW] {
        for vector in vectors(fixture) {
            let mut initiator = NoiseXx::initiator(
                &KeyPair::from_private(hex(field(&vector, "init_static")).try_into().unwrap()),
                Ephemeral::Fixed(hex(field(&vector, "init_ephemeral")).try_into().unwrap()),
                &hex(field(&vector, "init_prologue")),
                None,
            )
            .unwrap();
            let mut responder = NoiseXx::responder(
                &KeyPair::from_private(hex(field(&vector, "resp_static")).try_into().unwrap()),
                Ephemeral::Fixed(hex(field(&vector, "resp_ephemeral")).try_into().unwrap()),
                &hex(field(&vector, "resp_prologue")),
            )
            .unwrap();
            let messages = messages(&vector);
            for (index, (payload, ciphertext)) in messages.iter().take(3).enumerate() {
                let (written, read) = if index % 2 == 0 {
                    let written = initiator.write_message(payload).unwrap();
                    let read = responder.read_message(&written).unwrap();
                    (written, read)
                } else {
                    let written = responder.write_message(payload).unwrap();
                    let read = initiator.read_message(&written).unwrap();
                    (written, read)
                };
                assert_eq!(as_hex(&written), as_hex(ciphertext), "message {index}");
                assert_eq!(read, *payload);
            }
            if let Some(expected) = vector.get("handshake_hash").and_then(Value::as_str) {
                assert_eq!(as_hex(initiator.handshake_hash()), expected);
            }
            assert_eq!(initiator.handshake_hash(), responder.handshake_hash());
            let mut client = initiator.into_transport().unwrap();
            let mut daemon = responder.into_transport().unwrap();
            for (index, (payload, ciphertext)) in messages.iter().skip(3).enumerate() {
                // Global message 3 is odd: the responder sends it, as in the fixture's test.
                let responder_turn = index % 2 == 0;
                let sealed = if responder_turn {
                    daemon.send(payload).unwrap()
                } else {
                    client.send(payload).unwrap()
                };
                assert_eq!(as_hex(&sealed), as_hex(ciphertext), "transport {index}");
                let opened = if responder_turn {
                    client.receive(&sealed).unwrap()
                } else {
                    daemon.receive(&sealed).unwrap()
                };
                assert_eq!(&opened, payload);
            }
        }
    }
}

#[test]
fn a_pinned_fingerprint_that_does_not_match_aborts_before_the_payload() {
    let host = KeyPair::generate().unwrap();
    let wrong = host_id(&KeyPair::generate().unwrap().public);
    let mut a = NoiseXx::initiator(
        &KeyPair::generate().unwrap(),
        Ephemeral::Fresh,
        b"",
        Some(&wrong),
    )
    .unwrap();
    let mut b = NoiseXx::responder(&host, Ephemeral::Fresh, b"").unwrap();
    b.read_message(&a.write_message(&[]).unwrap()).unwrap();
    let error = a.read_message(&b.write_message(&[]).unwrap()).unwrap_err();
    assert!(error.to_string().contains("fingerprint"), "{error}");
    assert!(a.write_message(&[]).is_err());
    // The right pin completes.
    let pin = host.host_id();
    let mut a = NoiseXx::initiator(
        &KeyPair::generate().unwrap(),
        Ephemeral::Fresh,
        b"",
        Some(&pin),
    )
    .unwrap();
    let mut b = NoiseXx::responder(&host, Ephemeral::Fresh, b"").unwrap();
    b.read_message(&a.write_message(&[]).unwrap()).unwrap();
    assert_eq!(
        a.read_message(&b.write_message(&[]).unwrap()).unwrap(),
        Vec::<u8>::new()
    );
    assert_eq!(a.remote_static(), Some(host.public.as_slice()));
}

#[test]
fn the_finished_transport_carries_both_ways_and_rekeys_by_direction() {
    let host = KeyPair::generate().unwrap();
    let mut client = NoiseXx::initiator(
        &KeyPair::generate().unwrap(),
        Ephemeral::Fresh,
        b"relay",
        Some(&host.host_id()),
    )
    .unwrap();
    let mut daemon = NoiseXx::responder(&host, Ephemeral::Fresh, b"relay").unwrap();
    daemon
        .read_message(&client.write_message(b"hello").unwrap())
        .unwrap();
    client
        .read_message(&daemon.write_message(b"welcome").unwrap())
        .unwrap();
    daemon
        .read_message(&client.write_message(b"ready").unwrap())
        .unwrap();
    assert!(client.is_finished() && daemon.is_finished());
    let mut client = client.into_transport().unwrap();
    let mut daemon = daemon.into_transport().unwrap();
    assert_eq!(daemon.receive(&client.send(b"up").unwrap()).unwrap(), b"up");
    assert_eq!(
        client.receive(&daemon.send(b"down").unwrap()).unwrap(),
        b"down"
    );
    client.rekey_send();
    daemon.rekey_receive();
    assert_eq!(
        daemon
            .receive(&client.send(b"after rekey").unwrap())
            .unwrap(),
        b"after rekey".to_vec()
    );
    // A message sealed before the rekey doesn't open after it.
    let stale = daemon.send(b"old").unwrap();
    client.rekey_receive();
    assert!(client.receive(&stale).is_err());
}

#[test]
fn tampered_and_replayed_transport_messages_are_refused_without_advancing() {
    let host = KeyPair::generate().unwrap();
    let mut client =
        NoiseXx::initiator(&KeyPair::generate().unwrap(), Ephemeral::Fresh, b"", None).unwrap();
    let mut daemon = NoiseXx::responder(&host, Ephemeral::Fresh, b"").unwrap();
    daemon
        .read_message(&client.write_message(&[]).unwrap())
        .unwrap();
    client
        .read_message(&daemon.write_message(&[]).unwrap())
        .unwrap();
    daemon
        .read_message(&client.write_message(&[]).unwrap())
        .unwrap();
    let mut client = client.into_transport().unwrap();
    let mut daemon = daemon.into_transport().unwrap();
    let mut first = client.send(&[1]).unwrap();
    first[0] ^= 1;
    assert!(daemon.receive(&first).is_err());
    assert!(daemon.receive(&first).is_err());
}

#[test]
fn the_largest_transport_message_is_accepted_and_one_byte_more_is_refused() {
    let host = KeyPair::generate().unwrap();
    let mut client =
        NoiseXx::initiator(&KeyPair::generate().unwrap(), Ephemeral::Fresh, b"", None).unwrap();
    let mut daemon = NoiseXx::responder(&host, Ephemeral::Fresh, b"").unwrap();
    daemon
        .read_message(&client.write_message(&[]).unwrap())
        .unwrap();
    client
        .read_message(&daemon.write_message(&[]).unwrap())
        .unwrap();
    daemon
        .read_message(&client.write_message(&[]).unwrap())
        .unwrap();
    let mut client = client.into_transport().unwrap();
    let mut daemon = daemon.into_transport().unwrap();
    let message = client.send(&vec![7u8; MAX_MESSAGE - 16]).unwrap();
    assert_eq!(message.len(), MAX_MESSAGE);
    assert_eq!(daemon.receive(&message).unwrap().len(), MAX_MESSAGE - 16);
    assert!(client.send(&vec![7u8; MAX_MESSAGE - 15]).is_err());
}

#[test]
fn noise_nk_vectors_match_every_byte_and_its_finished_transport_interoperates() {
    for vector in vectors(NK) {
        let responder_static =
            KeyPair::from_private(hex(field(&vector, "resp_static")).try_into().unwrap());
        let mut initiator = NoiseNk::initiator(
            &responder_static.public,
            Ephemeral::Fixed(hex(field(&vector, "init_ephemeral")).try_into().unwrap()),
            &hex(field(&vector, "init_prologue")),
        )
        .unwrap();
        let mut responder = NoiseNk::responder(
            &responder_static,
            Ephemeral::Fixed(hex(field(&vector, "resp_ephemeral")).try_into().unwrap()),
            &hex(field(&vector, "resp_prologue")),
        )
        .unwrap();
        let messages = messages(&vector);
        let first = initiator.write_message(&messages[0].0).unwrap();
        assert_eq!(as_hex(&first), as_hex(&messages[0].1));
        assert_eq!(responder.read_message(&first).unwrap(), messages[0].0);
        let second = responder.write_message(&messages[1].0).unwrap();
        assert_eq!(as_hex(&second), as_hex(&messages[1].1));
        assert_eq!(initiator.read_message(&second).unwrap(), messages[1].0);
        assert_eq!(
            as_hex(responder.handshake_hash()),
            field(&vector, "handshake_hash")
        );
        assert_eq!(
            responder.remote_ephemeral(),
            Some(first[..32].try_into().unwrap())
        );
        let mut client = initiator.into_transport().unwrap();
        let mut daemon = responder.into_transport().unwrap();
        for (index, (payload, ciphertext)) in messages.iter().skip(2).enumerate() {
            let sealed = if index % 2 == 0 {
                client.send(payload).unwrap()
            } else {
                daemon.send(payload).unwrap()
            };
            assert_eq!(as_hex(&sealed), as_hex(ciphertext), "transport {index}");
            let opened = if index % 2 == 0 {
                daemon.receive(&sealed).unwrap()
            } else {
                client.receive(&sealed).unwrap()
            };
            assert_eq!(&opened, payload);
        }
    }
}

#[test]
fn an_nk_first_message_bound_to_another_prologue_or_key_is_refused() {
    let host = KeyPair::generate().unwrap();
    let first = NoiseNk::initiator(&host.public, Ephemeral::Fresh, b"v2")
        .unwrap()
        .write_message(b"early")
        .unwrap();
    let mut wrong_prologue = NoiseNk::responder(&host, Ephemeral::Fresh, b"v1").unwrap();
    assert!(wrong_prologue.read_message(&first).is_err());
    let mut wrong_key =
        NoiseNk::responder(&KeyPair::generate().unwrap(), Ephemeral::Fresh, b"v2").unwrap();
    assert!(wrong_key.read_message(&first).is_err());
    let mut right = NoiseNk::responder(&host, Ephemeral::Fresh, b"v2").unwrap();
    assert_eq!(right.read_message(&first).unwrap(), b"early");
}

#[test]
fn an_nk_first_message_is_48_bytes_and_cannot_be_taken_for_an_xx_one() {
    let host = KeyPair::generate().unwrap();
    let first = NoiseNk::initiator(&host.public, Ephemeral::Fresh, b"")
        .unwrap()
        .write_message(&[])
        .unwrap();
    assert_eq!(first.len(), NK_FIRST_MESSAGE_MINIMUM);
    let mut xx =
        NoiseXx::initiator(&KeyPair::generate().unwrap(), Ephemeral::Fresh, b"", None).unwrap();
    let xx_first = xx.write_message(&[]).unwrap();
    assert_eq!(xx_first.len(), 32);
    let mut responder = NoiseNk::responder(&host, Ephemeral::Fresh, b"").unwrap();
    let error = responder.read_message(&xx_first).unwrap_err();
    assert!(error.to_string().contains("Invalid Noise message size"));
}

#[test]
fn nk_keeps_turns_bounds_sizes_and_fails_for_good() {
    let host = KeyPair::generate().unwrap();
    let mut initiator = NoiseNk::initiator(&host.public, Ephemeral::Fresh, b"").unwrap();
    assert!(initiator.read_message(&[0u8; 48]).is_err());
    let mut responder = NoiseNk::responder(&host, Ephemeral::Fresh, b"").unwrap();
    assert!(responder.write_message(&[]).is_err());
    assert!(
        NoiseNk::initiator(&host.public, Ephemeral::Fresh, b"")
            .unwrap()
            .write_message(&vec![0u8; MAX_MESSAGE - 47])
            .is_err()
    );
    let largest = NoiseNk::initiator(&host.public, Ephemeral::Fresh, b"")
        .unwrap()
        .write_message(&vec![0u8; MAX_MESSAGE - NK_FIRST_MESSAGE_MINIMUM])
        .unwrap();
    assert_eq!(largest.len(), MAX_MESSAGE);
    let mut tampered = NoiseNk::initiator(&host.public, Ephemeral::Fresh, b"")
        .unwrap()
        .write_message(&[1])
        .unwrap();
    tampered[40] ^= 1;
    let mut reader = NoiseNk::responder(&host, Ephemeral::Fresh, b"").unwrap();
    assert!(reader.read_message(&tampered).is_err());
    assert!(reader.read_message(&tampered).is_err());
    assert!(reader.into_transport().is_err());
}

#[test]
fn a_replayed_first_message_s_answer_can_only_be_read_by_the_real_client() {
    let host = KeyPair::generate().unwrap();
    let mut client = NoiseNk::initiator(&host.public, Ephemeral::Fresh, b"").unwrap();
    let first = client.write_message(b"hello.early").unwrap();
    let mut replayed = NoiseNk::responder(&host, Ephemeral::Fresh, b"").unwrap();
    replayed.read_message(&first).unwrap();
    let answer = replayed.write_message(&[]).unwrap();
    let mut replayed = replayed.into_transport().unwrap();
    let sealed = replayed.send(b"welcome").unwrap();
    let mut guess = NoiseNk::initiator(&host.public, Ephemeral::Fresh, b"").unwrap();
    guess.write_message(&[]).unwrap();
    assert!(guess.read_message(&answer).is_err());
    client.read_message(&answer).unwrap();
    let mut client = client.into_transport().unwrap();
    assert_eq!(client.receive(&sealed).unwrap(), b"welcome");
}

#[test]
fn a_static_key_s_host_id_is_base32_of_its_digest_and_never_32_bytes_of_it() {
    let pair = KeyPair::from_private([7u8; 32]);
    let id = pair.host_id();
    assert_eq!(id.len(), 52);
    assert!(
        id.bytes()
            .all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte))
    );
    assert_eq!(host_id(&pair.public), id);
}
