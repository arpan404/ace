// SPDX-License-Identifier: Apache-2.0
//! Asymmetric hand-over against the TS cipher, and what failures leave in buffers.
use crate::relay::Transport;
use crate::tests::{bytes, key};
use crate::{CipherState, Error};
use media_wire::keys::KeyBlock;
use serde_json::Value;
use zeroize::Zeroizing;
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
type Stream = Transport<16>;

fn number(v: &Value) -> Result<u64> {
    Ok(v.as_str().ok_or("number")?.parse()?)
}
/// The key block a side holds after hand-over, `send` being its own direction.
fn block(send: &Value, receive: &Value) -> Result<Zeroizing<Vec<u8>>> {
    let b = KeyBlock {
        send_key: key(&send["key"])?,
        receive_key: key(&receive["key"])?,
        send_nonce: number(&send["nonce"])?,
        receive_nonce: number(&receive["nonce"])?,
        frames_sent: number(&send["frames"])?,
        frames_received: number(&receive["frames"])?,
        flags: 0,
        window: 0,
        unacked: 0,
        owed: 0,
        uncounted: 0,
    };
    Ok(Zeroizing::new(b.encode().map_err(|_| "block")?.to_vec()))
}
fn transcript() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "../../../vectors/noise-handover/scenarios.json"
    ))?)
}
#[test]
fn handover_with_different_keys_nonces_and_counts_per_direction_matches_ts_across_rekeys() -> Result
{
    let v = transcript()?;
    // `local` runs the in-place APIs over one buffer; `peer` is the other end, imported
    // with the directions swapped, through the copying wrappers.
    let mut local = Stream::import(block(&v["send"], &v["receive"])?)?;
    let mut peer = Stream::import(block(&v["receive"], &v["send"])?)?;
    let mut buffer = Zeroizing::new(Vec::new());
    let steps = v["steps"].as_array().ok_or("steps")?;
    for step in steps {
        let plain = bytes(&step["plain"])?;
        let sealed = bytes(&step["sealed"])?;
        buffer.clear();
        if step["direction"] == "send" {
            buffer.extend_from_slice(&plain);
            local.seal_in_place(&mut buffer)?;
            assert_eq!(*buffer, sealed, "step {}", step["index"]);
            assert_eq!(*peer.open(&buffer)?, plain);
        } else {
            assert_eq!(peer.seal(&plain)?, sealed, "step {}", step["index"]);
            buffer.extend_from_slice(&sealed);
            assert_eq!(local.open_in_place(&mut buffer)?, &plain[..]);
        }
    }
    let rekeys = |direction: &str| {
        steps
            .iter()
            .filter(|s| s["direction"] == direction && s["rekey"] == true)
            .count()
    };
    assert_eq!((rekeys("send"), rekeys("receive")), (3, 1));
    Ok(())
}
#[test]
fn failed_seal_wipes_and_empties_the_buffer_and_spends_no_nonce() -> Result {
    let mut cipher = CipherState::new(Zeroizing::new([5; 32]), 0)?;
    let mut peer = CipherState::new(Zeroizing::new([5; 32]), 0)?;
    let mut oversized = vec![9; 65520];
    assert_eq!(
        cipher.encrypt_in_place(&mut oversized, &[]),
        Err(Error::TooLarge)
    );
    assert!(oversized.is_empty());
    let mut exhausted = CipherState::new(Zeroizing::new([5; 32]), u64::MAX)?;
    let mut secret = b"secret".to_vec();
    assert_eq!(
        exhausted.encrypt_in_place(&mut secret, &[]),
        Err(Error::Closed)
    );
    assert!(secret.is_empty());
    let frame = cipher.encrypt(b"after", &[])?;
    assert_eq!(&**peer.decrypt(&frame, &[])?, b"after");
    Ok(())
}
#[test]
fn sealing_on_a_closed_stream_wipes_the_plaintext_buffer() -> Result {
    let v = transcript()?;
    let mut stream = Stream::import(block(&v["send"], &v["receive"])?)?;
    stream.close();
    let mut secret = b"secret".to_vec();
    assert_eq!(stream.seal_in_place(&mut secret), Err(Error::Closed));
    assert!(secret.is_empty());
    assert!(stream.seal(b"secret").is_err());
    Ok(())
}
#[test]
fn sealing_a_full_buffer_moves_it_once_and_still_matches_ts() -> Result {
    let v = transcript()?;
    let mut stream = Stream::import(block(&v["send"], &v["receive"])?)?;
    let step = &v["steps"][0];
    let plain = bytes(&step["plain"])?;
    let mut buffer = Vec::with_capacity(plain.len());
    buffer.extend_from_slice(&plain);
    stream.seal_in_place(&mut buffer)?;
    assert_eq!(buffer, bytes(&step["sealed"])?);
    Ok(())
}
#[test]
fn corrupted_tag_or_wrong_ad_wipes_the_buffer_in_place() -> Result {
    let mut sender = CipherState::new(Zeroizing::new([6; 32]), 0)?;
    let mut receiver = CipherState::new(Zeroizing::new([6; 32]), 0)?;
    let frame = sender.encrypt(b"secret frame", b"ad")?;
    let mut wrong_ad = frame.clone();
    assert_eq!(
        receiver.decrypt_in_place(&mut wrong_ad, b"other"),
        Err(Error::Authentication)
    );
    assert!(wrong_ad.iter().all(|&b| b == 0));
    let mut bad_tag = frame.clone();
    *bad_tag.last_mut().ok_or("tag")? ^= 1;
    assert_eq!(
        receiver.decrypt_in_place(&mut bad_tag, b"ad"),
        Err(Error::Authentication)
    );
    assert!(bad_tag.iter().all(|&b| b == 0));
    // A failed open does not spend the nonce at this layer.
    let mut good = frame;
    assert_eq!(
        receiver.decrypt_in_place(&mut good, b"ad")?,
        b"secret frame"
    );
    Ok(())
}
#[test]
fn corrupted_frame_opened_in_place_wipes_it_and_closes_both_directions() -> Result {
    let v = transcript()?;
    let mut local = Stream::import(block(&v["send"], &v["receive"])?)?;
    let first_received = v["steps"]
        .as_array()
        .ok_or("steps")?
        .iter()
        .find(|s| s["direction"] == "receive")
        .ok_or("receive step")?;
    let sealed = bytes(&first_received["sealed"])?;
    let mut corrupted = sealed.clone();
    corrupted[0] ^= 1;
    assert_eq!(
        local.open_in_place(&mut corrupted),
        Err(Error::Authentication)
    );
    assert!(corrupted.iter().all(|&b| b == 0));
    let mut intact = sealed;
    assert_eq!(local.open_in_place(&mut intact), Err(Error::Closed));
    assert!(intact.iter().all(|&b| b == 0));
    let mut secret = b"secret".to_vec();
    assert_eq!(local.seal_in_place(&mut secret), Err(Error::Closed));
    assert!(secret.is_empty());
    Ok(())
}
