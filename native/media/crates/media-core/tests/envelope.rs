// SPDX-License-Identifier: Apache-2.0
mod support;
use media_core::envelope::*;

fn wire(piece: &Piece<'_>) -> Vec<u8> {
    let mut out = vec![0; piece.len()];
    assert_eq!(piece.write_to(&mut out), Ok(out.len()));
    out
}
#[test]
fn every_piece_matches_the_shared_typescript_bytes() -> Result<(), Box<dyn std::error::Error>> {
    let fixtures = support::hex_fields(include_str!("../../../vectors/envelope/scenarios.json"));
    let mut expected = fixtures.iter();
    for size in [1, 65500, 65536, 131072] {
        let payload = vec![7; size];
        let mut assembler = Assembler::new();
        for piece in Pieces::new(2, 42, &[1, 2], &payload)? {
            let bytes = wire(&piece);
            assert_eq!(Some(&bytes), expected.next());
            if let Some(message) = assembler.push(&bytes)? {
                assert_eq!(message.kind, 2);
                assert_eq!(message.meta, [1, 2]);
                assert_eq!(message.payload, payload);
            }
        }
    }
    assert!(expected.next().is_none());
    Ok(())
}
#[test]
fn smaller_noise_pieces_reassemble_without_copying_at_split()
-> Result<(), Box<dyn std::error::Error>> {
    for (meta_size, payload_size) in [
        (0, 0),
        (2, 1),
        (65535, 70000),
        (100, 300000),
        (0, MAX_BYTES),
    ] {
        let meta = vec![3; meta_size];
        let payload = vec![7; payload_size];
        let mut assembler = Assembler::new();
        let mut completed = 0;
        let mut count = 0;
        for p in Pieces::new(255, u32::MAX, &meta, &payload)? {
            assert!(p.len() <= PIECE_BYTES);
            if !p.payload.is_empty() {
                assert!(p.payload.as_ptr() >= payload.as_ptr());
                assert!(p.payload.as_ptr() < payload.as_ptr().wrapping_add(payload.len()));
            }
            let bytes = wire(&p);
            count += 1;
            if let Some(e) = assembler.push(&bytes)? {
                completed += 1;
                assert_eq!(e.meta, meta);
                assert_eq!(e.payload, payload);
            }
        }
        assert_eq!(completed, 1);
        assert_eq!(
            count,
            (meta_size + payload_size)
                .div_ceil(PIECE_BYTES - PREFIX_BYTES)
                .max(1)
        );
    }
    Ok(())
}
#[test]
fn single_piece_receive_borrows_the_wire_buffer() -> Result<(), Box<dyn std::error::Error>> {
    let bytes = wire(&Pieces::new(7, 0, &[1], &[2, 3])?.next().ok_or("piece")?);
    let mut a = Assembler::new();
    let e = a.push(&bytes)?.ok_or("message")?;
    assert_eq!(e.meta.as_ptr(), bytes[PREFIX_BYTES..].as_ptr());
    assert_eq!(e.payload.as_ptr(), bytes[PREFIX_BYTES + 1..].as_ptr());
    Ok(())
}
#[test]
fn malformed_pieces_and_out_of_order_continuations_are_refused()
-> Result<(), Box<dyn std::error::Error>> {
    let payload = vec![7; 100000];
    let pieces: Vec<_> = Pieces::new(2, 4, &[1, 2], &payload)?
        .map(|p| wire(&p))
        .collect();
    let mut a = Assembler::new();
    assert_eq!(a.push(&pieces[1]), Err(Error::Order));
    for (at, value, error) in [
        (0, 0, Error::Magic),
        (4, 2, Error::Version),
        (12, 255, Error::Bounds),
    ] {
        let mut bad = pieces[0].clone();
        bad[at] = value;
        assert_eq!(a.push(&bad), Err(error));
    }
    assert_eq!(a.push(&[]), Err(Error::Bounds));
    assert_eq!(a.push(&vec![0; LEGACY_PIECE_BYTES + 1]), Err(Error::Bounds));
    for at in [5, 6, 8, 15, 19] {
        assert!(a.push(&pieces[0])?.is_none());
        let mut bad = pieces[1].clone();
        bad[at] ^= 1;
        assert!(a.push(&bad).is_err());
        a.reset();
        assert!(a.push(&pieces[1]).is_err());
    }
    assert!(Pieces::new(0, 0, &[], &[]).is_err());
    assert!(Pieces::new(1, 0, &vec![0; 65536], &[]).is_err());
    assert!(Pieces::new(1, 0, &[], &vec![0; MAX_BYTES + 1]).is_err());
    Ok(())
}
#[test]
fn restart_and_reset_discard_the_previous_partial_message() -> Result<(), Box<dyn std::error::Error>>
{
    let payload = vec![7; 100000];
    let p: Vec<_> = Pieces::new(2, 4, &[], &payload)?
        .map(|p| wire(&p))
        .collect();
    let mut a = Assembler::new();
    assert!(a.push(&p[0])?.is_none());
    let small = wire(&Pieces::new(99, 5, &[], &[9])?.next().ok_or("piece")?);
    assert_eq!(a.push(&small)?.ok_or("message")?.payload, [9]);
    assert!(a.push(&p[1]).is_err());
    assert!(a.push(&p[0])?.is_none());
    a.reset();
    assert!(a.push(&p[1]).is_err());
    let mut empty = p[0][..PREFIX_BYTES].to_vec();
    assert_eq!(a.push(&empty), Err(Error::Empty));
    empty[12..16].copy_from_slice(&0_u32.to_be_bytes());
    assert_eq!(a.push(&empty)?.ok_or("empty message")?.payload, []);
    Ok(())
}

#[test]
fn completed_fragmented_messages_reuse_warmed_storage() -> Result<(), Box<dyn std::error::Error>> {
    let payload = vec![7; 300000];
    let pieces: Vec<_> = Pieces::new(2, 0, &[1, 2], &payload)?
        .map(|p| wire(&p))
        .collect();
    let mut a = Assembler::new();
    let mut previous = None;
    for _ in 0..10 {
        for p in &pieces {
            if let Some(e) = a.push(p)? {
                assert_eq!(e.payload, payload);
                let address = e.payload.as_ptr();
                if let Some(previous) = previous {
                    assert_eq!(address, previous);
                }
                previous = Some(address);
            }
        }
    }
    Ok(())
}
