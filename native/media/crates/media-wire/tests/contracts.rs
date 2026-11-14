use media_wire::{
    control::{ControlFrame, FromMedia, ToMedia, lane},
    frame::{Egress, MediaFrame},
    keys::{KeyBlock, crc32c},
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::PathBuf};
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors")
}
fn hex(s: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    (0..s.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&s[i..i + 2], 16)?))
        .collect()
}
#[test]
fn every_control_message_round_trips_with_payload_and_lane()
-> Result<(), Box<dyn std::error::Error>> {
    let mut to = BTreeSet::new();
    let mut from = BTreeSet::new();
    for entry in fs::read_dir(root().join("control"))? {
        let fixture: Value = serde_json::from_slice(&fs::read(entry?.path())?)?;
        let m = &fixture["message"];
        let kind = m["type"].as_str().ok_or("missing type")?;
        let mut bad = m.clone();
        bad["unknown"] = json!(true);
        let payload = vec![
            0;
            match kind {
                "init" | "source.open" | "media.ticket" => 32,
                "relay.keys" => 120,
                "listen" =>
                    (m["remote"]["certificateBytes"].as_u64().unwrap_or(0)
                        + m["remote"]["keyBytes"].as_u64().unwrap_or(0))
                        as usize,
                _ => 0,
            }
        ];
        if fixture["direction"] == "ToMedia" {
            let msg: ToMedia = serde_json::from_value(m.clone())?;
            assert_eq!(serde_json::to_value(&msg)?, *m);
            assert!(serde_json::from_value::<ToMedia>(bad).is_err());
            let frame = ControlFrame {
                message: msg,
                payload: zeroize::Zeroizing::new(payload),
            };
            let mut encoded = frame.header(lane(kind)).map_err(|_| "encode")?;
            encoded.extend_from_slice(&frame.payload);
            assert_eq!(
                ControlFrame::<ToMedia>::decode(&encoded, lane(kind))
                    .map_err(|_| "decode")?
                    .message,
                frame.message
            );
            assert!(
                ControlFrame::<ToMedia>::decode(&encoded[..encoded.len() - 1], lane(kind)).is_err()
            );
            to.insert(kind.to_owned());
        } else {
            let msg: FromMedia = serde_json::from_value(m.clone())?;
            assert_eq!(serde_json::to_value(&msg)?, *m);
            assert!(serde_json::from_value::<FromMedia>(bad).is_err());
            let frame = ControlFrame {
                message: msg,
                payload: zeroize::Zeroizing::new(payload),
            };
            let mut encoded = frame.header(lane(kind)).map_err(|_| "encode")?;
            encoded.extend_from_slice(&frame.payload);
            assert_eq!(
                ControlFrame::<FromMedia>::decode(&encoded, lane(kind))
                    .map_err(|_| "decode")?
                    .message,
                frame.message
            );
            from.insert(kind.to_owned());
        }
    }
    assert_eq!(to, variants::<ToMedia>());
    assert_eq!(from, variants::<FromMedia>());
    Ok(())
}
#[test]
fn shared_frames_retain_extensions_flags_epochs_and_egress_identity()
-> Result<(), Box<dyn std::error::Error>> {
    let fixtures: Vec<Value> =
        serde_json::from_slice(&fs::read(root().join("frame/contracts.json"))?)?;
    for f in fixtures {
        let b = hex(f["hex"].as_str().ok_or("hex")?)?;
        let decoded = MediaFrame::decode(&b).map_err(|_| "decode")?;
        let kind: u8 = f["kind"].as_u64().ok_or("kind")?.try_into()?;
        let expected = MediaFrame {
            kind,
            flags: 0x80000005,
            age_us: 123456,
            width: 1920,
            height: 1080,
            display_width: 960,
            display_height: 540,
            scale: 2000,
            rotation: 1,
            codec: if kind == 5 { 0 } else { 2 },
            encode: 99,
            epoch: 42,
            codec_string: "avc1.640028".into(),
            description: vec![1, 100, 0, 40],
            extension: vec![200, 201],
            payload: if kind == 5 {
                vec![7; 32]
            } else {
                vec![0, 1, 2, 255]
            },
        };
        assert_eq!(decoded, expected);
        assert_eq!(expected.encode().map_err(|_| "encode expected")?, b);
        assert_eq!(decoded.epoch, 42);
        assert_eq!(decoded.flags, 0x80000005);
        assert_eq!(decoded.extension, vec![200, 201]);
        assert_eq!(decoded.encode().map_err(|_| "encode")?, b);
        let e = hex(f["egressHex"].as_str().ok_or("egress")?)?;
        let egress = Egress::decode(&e).map_err(|_| "egress")?;
        assert_eq!((egress.handle, egress.sequence), (0x12345678, u32::MAX));
        assert_eq!(egress.frame, decoded);
        assert_eq!(egress.encode().map_err(|_| "egress encode")?, e);
        for length in 0..b.len() {
            assert!(MediaFrame::decode(&b[..length]).is_err());
        }
        for (offset, bytes) in [
            (0, vec![0]),
            (4, vec![2]),
            (5, vec![0]),
            (6, vec![0, 43]),
            (6, vec![16, 1]),
            (8, vec![0, 128, 0, 1]),
            (40, vec![255, 255]),
            (30, vec![4]),
            (44, vec![255]),
        ] {
            let mut bad = b.clone();
            bad[offset..offset + bytes.len()].copy_from_slice(&bytes);
            assert!(MediaFrame::decode(&bad).is_err());
        }
    }
    Ok(())
}
#[test]
fn key_block_matches_shared_bytes_and_rejects_every_single_byte_corruption()
-> Result<(), Box<dyn std::error::Error>> {
    assert_eq!(crc32c(b"123456789"), 0xe3069283);
    let f: Value = serde_json::from_slice(&fs::read(root().join("key-block/contracts.json"))?)?;
    let b = hex(f["hex"].as_str().ok_or("hex")?)?;
    let block = KeyBlock::decode(&b).map_err(|_| "key block")?;
    assert_eq!(block.send_key.as_slice(), &(0u8..32).collect::<Vec<_>>());
    assert_eq!(
        block.receive_key.as_slice(),
        &(224u8..=255).rev().collect::<Vec<_>>()
    );
    assert_eq!(
        (
            block.frames_sent,
            block.frames_received,
            block.flags,
            block.window,
            block.unacked,
            block.owed,
            block.uncounted
        ),
        (1048575, 1048576, 3, 1048576, 4096, 4096, 0)
    );
    assert_eq!(block.send_nonce, 0x123456789abcdef0);
    assert_eq!(block.receive_nonce, u64::MAX);
    assert_eq!(block.encode().map_err(|_| "encode")?.as_slice(), b);
    for i in 0..120 {
        let mut bad = b.clone();
        bad[i] ^= 1;
        assert!(KeyBlock::decode(&bad).is_err());
    }
    for n in 0..120 {
        assert!(KeyBlock::decode(&b[..n]).is_err());
    }
    Ok(())
}

// Capture serde's own derived variant inventory, so adding a variant cannot bypass fixtures.
#[derive(Debug)]
struct Variants(Vec<String>);
impl std::fmt::Display for Variants {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "variant inventory")
    }
}
impl std::error::Error for Variants {}
impl serde::de::Error for Variants {
    fn custom<T: std::fmt::Display>(_: T) -> Self {
        Self(vec![])
    }
    fn unknown_variant(_: &str, expected: &'static [&'static str]) -> Self {
        Self(expected.iter().map(|s| (*s).to_owned()).collect())
    }
}
fn variants<M: for<'de> serde::Deserialize<'de>>() -> BTreeSet<String> {
    let entries = vec![("type", "__inventory")];
    match M::deserialize(serde::de::value::MapDeserializer::<_, Variants>::new(
        entries.into_iter(),
    )) {
        Err(e) => e.0.into_iter().collect(),
        Ok(_) => panic!("inventory tag accepted"),
    }
}
#[test]
fn control_rejects_malformed_contracts_and_preserves_opaque_metadata()
-> Result<(), Box<dyn std::error::Error>> {
    for bad in [
        json!({"type":"ping","id":"x".repeat(65)}),
        json!({"type":"source.epoch","source":"s","seq":9007199254740992u64,"epoch":1}),
        json!({"type":"record.epochs","source":"s","seq":0,"decided":4,"clear":[[4,2]],"discard":[]}),
        json!({"type":"unknown"}),
    ] {
        assert!(serde_json::from_value::<ToMedia>(bad).is_err());
    }
    let metadata =
        json!({"type":"record.meta","recording":"r","epoch":3,"data":{"future":{"nested":12}}});
    let m: ToMedia = serde_json::from_value(metadata.clone())?;
    assert_eq!(serde_json::to_value(m)?, metadata);
    let m: ToMedia = serde_json::from_value(json!({"type":"ping","id":"p"}))?;
    let mut frame = ControlFrame {
        message: m,
        payload: zeroize::Zeroizing::new(vec![]),
    };
    let bytes = frame.header(lane("ping")).map_err(|_| "encode")?;
    assert!(ControlFrame::<ToMedia>::decode(&bytes, lane("revoke")).is_err());
    for n in [0u32, 3, 8 * 1024 * 1024 + 1] {
        let mut bad = bytes.clone();
        bad[..4].copy_from_slice(&n.to_be_bytes());
        assert!(ControlFrame::<ToMedia>::decode(&bad, lane("ping")).is_err());
    }
    let mut bad = bytes;
    bad[8] = 255;
    assert!(ControlFrame::<ToMedia>::decode(&bad, lane("ping")).is_err());
    frame.payload.extend_from_slice(&[0; 32]);
    assert!(frame.header(lane("ping")).is_err());
    Ok(())
}
#[test]
fn key_block_reserved_bytes_and_flags_are_rejected_with_a_correct_crc()
-> Result<(), Box<dyn std::error::Error>> {
    let f: Value = serde_json::from_slice(&fs::read(root().join("key-block/contracts.json"))?)?;
    let b = hex(f["hex"].as_str().ok_or("hex")?)?;
    for (at, value) in [(96, 4), (97, 1), (98, 1), (99, 1)] {
        let mut bad = b.clone();
        bad[at] = value;
        let crc = crc32c(&bad[..116]);
        bad[116..].copy_from_slice(&crc.to_be_bytes());
        assert!(KeyBlock::decode(&bad).is_err());
    }
    Ok(())
}
