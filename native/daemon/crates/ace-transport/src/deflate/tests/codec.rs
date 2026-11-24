// SPDX-License-Identifier: Apache-2.0
//! The codec's own proof: every corpus round-trips through raw deflate at the
//! windows a negotiation can produce, the three 1 MiB boundaries fail where `ws`
//! fails, and the 8-bit-window decoder in `window8.rs` accepts our window-8 output
//! while refusing the same corpora at 15.

use super::window8;
use super::{Body, Deflater, Inflating, deflate_window};
use crate::frame::assemble::MessageBody;
use crate::frame::{CloseCode, FrameError, MAX_MESSAGE_BYTES};

/// A deterministic pseudo-random byte stream (an LCG): the corpora below are
/// fixed, so a failure is a failure, never a flake.
fn noise(seed: u64, length: usize) -> Vec<u8> {
    let mut state = seed;
    (0..length)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as u8
        })
        .collect()
}

/// A corpus with a long-range repeat: a later copy of an 8 KiB block earlier in
/// it, so a 15-bit deflater emits a distance past 256 and an 8-bit one cannot.
fn with_long_repeat(mut corpus: Vec<u8>) -> Vec<u8> {
    let block = corpus[..8 * 1024].to_vec();
    corpus.extend_from_slice(b"\n--- repeated tool output ---\n");
    corpus.extend_from_slice(&block);
    corpus
}

fn repetitive() -> Vec<u8> {
    with_long_repeat(noise(7, 2 * 1024).repeat(20))
}

fn random_words() -> Vec<u8> {
    let words = [
        "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
        "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon",
    ];
    let mut state = 99u64;
    let mut corpus = Vec::with_capacity(200 * 1024);
    while corpus.len() < 200 * 1024 {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        corpus.extend_from_slice(words[(state >> 33) as usize % words.len()].as_bytes());
        corpus.push(b' ');
    }
    with_long_repeat(corpus)
}

fn transcript() -> Vec<u8> {
    let mut corpus = Vec::with_capacity(200 * 1024);
    for line in 0..4000 {
        corpus.extend_from_slice(
            format!(
                "  const value{} = await readConfig(path, {{ strict: true }});\n",
                line % 50
            )
            .as_bytes(),
        );
    }
    with_long_repeat(corpus)
}

fn mebibyte() -> Vec<u8> {
    let mut corpus = Vec::with_capacity(MAX_MESSAGE_BYTES);
    let mut state = 4242u64;
    while corpus.len() < MAX_MESSAGE_BYTES {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(7);
        corpus.extend_from_slice(
            format!(
                "{{\"role\":\"assistant\",\"part\":{},\"text\":\"the same reply again\"}}\n",
                state >> 40
            )
            .as_bytes(),
        );
    }
    corpus.truncate(MAX_MESSAGE_BYTES);
    with_long_repeat_prefix(corpus)
}

/// The 1 MiB corpus keeps its size: the repeat replaces bytes at the end rather
/// than growing it.
fn with_long_repeat_prefix(mut corpus: Vec<u8>) -> Vec<u8> {
    let block = corpus[..8 * 1024].to_vec();
    let length = corpus.len();
    corpus.truncate(length - block.len());
    corpus.extend_from_slice(&block);
    corpus
}

fn corpora() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("repetitive", repetitive()),
        ("random words", random_words()),
        ("200 KiB transcript", transcript()),
        ("1 MiB message", mebibyte()),
    ]
}

#[test]
fn a_corpus_round_trips_through_the_codec_at_every_window() {
    for (name, corpus) in corpora() {
        for bits in [None, Some(8), Some(10), Some(15)] {
            let mut deflater = Deflater::new(deflate_window(bits));
            let compressed = deflater.deflate(&corpus).expect("a deflate");
            assert!(compressed.len() < corpus.len(), "{name} at {bits:?} shrank");
            let mut inflating = Inflating::new();
            inflating.feed(&compressed, true).expect("it inflates");
            assert_eq!(inflating.finish(), corpus, "{name} at {bits:?}");
        }
    }
}

#[test]
fn an_eight_bit_window_holds_every_corpus_and_a_fifteen_bit_one_does_not() {
    // The decoder's history is 256 bytes: the window an 8-bit client is entitled
    // to. `deflate_window(Some(8))` builds 9, and zlib-rs at level 6 keeps its
    // matches within 250 bytes, so every frame decodes. The same corpora at 15
    // reach past 256, which is what proves the decoder discriminates.
    for (name, corpus) in corpora() {
        let mut narrow = Deflater::new(deflate_window(Some(8)));
        let compressed = narrow.deflate(&corpus).expect("a deflate");
        assert_eq!(
            window8::decode_message(&compressed)
                .unwrap_or_else(|error| panic!("{name}: {error:?}")),
            corpus,
            "{name} at 8"
        );

        let mut wide = Deflater::new(deflate_window(Some(15)));
        let compressed = wide.deflate(&corpus).expect("a deflate");
        assert!(
            matches!(
                window8::decode_message(&compressed),
                Err(window8::Error::DistanceTooFar { .. })
            ),
            "{name} at 15 must reach past an 8-bit window"
        );
    }
}

#[test]
fn exactly_one_mebibyte_after_inflation_passes_and_the_byte_past_it_closes_1009() {
    for size in [MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES + 1] {
        let message = vec![b'a'; size];
        let mut deflater = Deflater::new(15);
        let compressed = deflater.deflate(&message).expect("a deflate");
        let mut inflating = Inflating::new();
        let outcome = inflating.feed(&compressed, true);
        if size == MAX_MESSAGE_BYTES {
            assert_eq!(outcome, Ok(MAX_MESSAGE_BYTES));
            assert_eq!(inflating.finish().len(), MAX_MESSAGE_BYTES);
        } else {
            assert_eq!(outcome, Err(CloseCode::TooBig));
        }
    }
}

#[test]
fn a_small_frame_inflating_past_the_limit_fails_before_its_final_fragment() {
    // 2 MiB of one byte deflates to about 2 KiB: the cap must stop the inflate
    // loop itself, not wait for the message to arrive.
    let message = vec![b'a'; 2 * MAX_MESSAGE_BYTES];
    let mut deflater = Deflater::new(15);
    let compressed = deflater.deflate(&message).expect("a deflate");
    assert!(compressed.len() < 4 * 1024, "the bomb is small");
    let mut inflating = Inflating::new();
    let first = compressed.len() * 3 / 4;
    assert_eq!(
        inflating.feed(&compressed[..first], false),
        Err(CloseCode::TooBig),
        "three quarters of the compressed stream is already past the limit"
    );
}

#[test]
fn a_fragmented_compressed_message_is_inflated_across_its_fragments() {
    let corpus = transcript();
    let mut deflater = Deflater::new(9);
    let compressed = deflater.deflate(&corpus).expect("a deflate");
    let mut inflating = Inflating::new();
    let third = compressed.len() / 3;
    assert!(inflating.feed(&compressed[..third], false).is_ok());
    assert!(inflating.feed(&compressed[third..2 * third], false).is_ok());
    assert_eq!(
        inflating.feed(&compressed[2 * third..], true),
        Ok(corpus.len())
    );
    assert_eq!(inflating.finish(), corpus);
    // And the context is fresh for the next message.
    inflating.reset();
    assert_eq!(inflating.feed(&compressed, true), Ok(corpus.len()));
    assert_eq!(inflating.finish(), corpus);
}

#[test]
fn a_corrupt_stream_closes_1007() {
    // A stored block whose complement does not match its length: not a stream
    // any inflater accepts.
    let mut inflating = Inflating::new();
    let outcome = inflating.feed(&[0x01, 0x05, 0x00, 0x00, 0x00, 0x61, 0x61], true);
    assert_eq!(outcome, Err(CloseCode::BadDeflate));
    assert_eq!(
        FrameError::from(CloseCode::BadDeflate).close_code(),
        Some(1007)
    );
}

#[test]
fn a_negotiated_socket_reads_an_uncompressed_message_as_it_is() {
    let mut body = Body::compressed();
    body.begin(false);
    assert_eq!(body.feed(b"plain bytes", true), Ok(11));
    assert_eq!(body.finish(), b"plain bytes".to_vec());
    body.reset();
    // And a compressed one still inflates in the same body.
    let mut deflater = Deflater::new(15);
    let compressed = deflater.deflate(b"compressed bytes").expect("a deflate");
    body.begin(true);
    assert_eq!(body.feed(&compressed, true), Ok(16));
    assert_eq!(body.finish(), b"compressed bytes".to_vec());
}
