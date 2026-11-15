// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::secret::LaneSecret;

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

struct Vector {
    secret: Vec<u8>,
    cases: Vec<serde_json::Value>,
}

fn vector() -> Vector {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("../../../vectors/lane/proofs.json")).unwrap();
    Vector {
        secret: hex(doc["secret"].as_str().unwrap()),
        cases: doc["cases"].as_array().unwrap().clone(),
    }
}

/// The vector's handshake transcript for `tag`.
fn transcript(v: &Vector, tag: u8) -> Vec<u8> {
    let case = v
        .cases
        .iter()
        .find(|case| case["tag"].as_u64() == Some(u64::from(tag)))
        .unwrap();
    hex(case["transcript"].as_str().unwrap())
}

/// Both ends of one lane with the same keys.
fn pair<const N: u64>(tag: u8) -> (Records<N>, Records<N>) {
    let v = vector();
    let secret = LaneSecret::from_payload(&v.secret).unwrap();
    let media = Records::media_side(derive(&secret, &transcript(&v, tag))).unwrap();
    let daemon = Records::daemon_side(derive(&secret, &transcript(&v, tag))).unwrap();
    (media, daemon)
}

/// One record's body (without its length), opened.
fn open<const N: u64>(
    records: &mut Records<N>,
    record: &[u8],
) -> Result<Vec<u8>, media_noise::Error> {
    let length = usize::from(u16::from_be_bytes([record[0], record[1]]));
    assert_eq!(length, record.len() - 2);
    let mut body = record[2..].to_vec();
    records.open(&mut body).map(|plain| plain.to_vec())
}

#[test]
fn keys_and_records_are_the_shared_vectors_for_both_lanes() {
    let v = vector();
    let secret = LaneSecret::from_payload(&v.secret).unwrap();
    for case in &v.cases {
        let tag = u8::try_from(case["tag"].as_u64().unwrap()).unwrap();
        let keys = derive(&secret, &transcript(&v, tag));
        assert_eq!(
            keys.to_media[..],
            hex(case["toMediaKey"].as_str().unwrap())[..]
        );
        assert_eq!(
            keys.to_daemon[..],
            hex(case["toDaemonKey"].as_str().unwrap())[..]
        );
        let (mut media, mut daemon) = pair::<{ media_noise::REKEY_INTERVAL }>(tag);
        let mut out = Vec::new();
        media.seal(&[LANE_ACCEPTED_PLAIN], &mut out).unwrap();
        assert_eq!(
            out,
            hex(case["acceptRecord"].as_str().unwrap()),
            "tag {tag}"
        );
        out.clear();
        daemon.seal(b"ping", &mut out).unwrap();
        assert_eq!(out, hex(case["firstRecord"].as_str().unwrap()), "tag {tag}");
        assert_eq!(open(&mut media, &out).unwrap(), b"ping");
    }
}

#[test]
fn records_open_in_order_and_anything_else_closes_the_lane() {
    type Case = (&'static str, fn(&[Vec<u8>], &[u8]) -> Vec<u8>);
    let cases: [Case; 4] = [
        ("a modified byte", |records, _| {
            let mut changed = records[0].clone();
            changed[5] ^= 1;
            changed
        }),
        // The second record before the first.
        ("out of sequence", |records, _| records[1].clone()),
        // The first record again after it was opened is handled below; here a record of the
        // other direction (the daemon's own key) is injected.
        ("the other direction's record", |_, injected| {
            injected.to_vec()
        }),
        ("a truncated record", |records, _| {
            let mut short = records[0][..records[0].len() - 1].to_vec();
            let length = u16::try_from(short.len() - 2).unwrap();
            short[..2].copy_from_slice(&length.to_be_bytes());
            short
        }),
    ];
    for (name, tamper) in cases {
        let (mut media, mut daemon) = pair::<{ media_noise::REKEY_INTERVAL }>(1);
        let mut sealed = Vec::new();
        for text in [b"one".as_slice(), b"two"] {
            let mut out = Vec::new();
            daemon.seal(text, &mut out).unwrap();
            sealed.push(out);
        }
        let mut injected = Vec::new();
        media.seal(b"evil", &mut injected).unwrap();
        let mut fresh = pair::<{ media_noise::REKEY_INTERVAL }>(1).0;
        assert!(
            open(&mut fresh, &tamper(&sealed, &injected)).is_err(),
            "{name}"
        );
        // Closed: even the genuine first record is refused now.
        assert!(open(&mut fresh, &sealed[0]).is_err(), "{name}: still open");
    }
}

#[test]
fn a_replayed_record_is_refused() {
    let (mut media, mut daemon) = pair::<{ media_noise::REKEY_INTERVAL }>(2);
    let mut first = Vec::new();
    daemon.seal(b"frame", &mut first).unwrap();
    assert_eq!(open(&mut media, &first).unwrap(), b"frame");
    assert!(open(&mut media, &first).is_err());
}

#[test]
fn both_sides_rekey_together_and_keep_opening() {
    let (mut media, mut daemon) = pair::<4>(1);
    for n in 0..20u8 {
        let mut out = Vec::new();
        daemon.seal(&[n], &mut out).unwrap();
        assert_eq!(open(&mut media, &out).unwrap(), [n], "record {n}");
    }
}

#[test]
fn a_chunk_too_large_for_one_record_is_refused_and_sealing_reuses_its_buffer() {
    let (mut media, _) = pair::<{ media_noise::REKEY_INTERVAL }>(2);
    let mut out = Vec::with_capacity(MAX_PLAIN + 18);
    assert!(media.seal(&vec![0; MAX_PLAIN + 1], &mut out).is_err());
    let capacity = out.capacity();
    let pointer = out.as_ptr();
    for _ in 0..100 {
        out.clear();
        media.seal(&[7; MAX_PLAIN], &mut out).unwrap();
        assert_eq!(out.len(), MAX_PLAIN + 18);
    }
    assert_eq!(
        (out.capacity(), out.as_ptr()),
        (capacity, pointer),
        "sealing reallocated"
    );
}
