// SPDX-License-Identifier: Apache-2.0
use super::*;

/// VideoToolbox's avcC for the H.264 vector media-mp4 checks against.
fn avcc() -> Vec<u8> {
    let fixture = include_bytes!("../../media-mp4/tests/vectors/h264.bin");
    let n = u32::from_be_bytes([fixture[0], fixture[1], fixture[2], fixture[3]]) as usize;
    fixture[4..4 + n].to_vec()
}

fn record(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = ((body.len() + 1) as u32).to_be_bytes().to_vec();
    out.push(tag);
    out.extend_from_slice(body);
    out
}

/// One access unit of two NAL units, each with a 4-byte length.
fn unit(first: u8) -> Vec<u8> {
    let mut out = Vec::new();
    for nal in [[first, 0x88, 0x84], [0x06, 0x05, 0x01]] {
        out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        out.extend_from_slice(&nal);
    }
    out
}

fn chunked(body: &[u8]) -> Vec<u8> {
    let mut out = b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
    for chunk in body.chunks(7) {
        out.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"0\r\n\r\n");
    out
}

fn stream() -> Vec<u8> {
    [
        record(4, b"jpeg preview seed"),
        record(1, &avcc()),
        record(2, &unit(0x25)),
        record(3, &unit(0x21)),
    ]
    .concat()
}

/// Feeds `response` a byte at a time when `bytewise`, else whole.
fn read(response: &[u8], bytewise: bool) -> Result<(Vec<Record>, bool), ReadError> {
    let (mut http, mut records, mut body, mut out) = (
        HttpBody::default(),
        Records::default(),
        Vec::new(),
        Vec::new(),
    );
    let pieces: Vec<&[u8]> = if bytewise {
        response.chunks(1).collect()
    } else {
        vec![response]
    };
    for piece in pieces {
        body.clear();
        http.push(piece, &mut body)?;
        records.push(&body, &mut out)?;
    }
    Ok((out, http.finished()))
}

#[test]
fn records_come_out_of_a_chunked_or_plain_body_however_it_is_split() {
    let expected = vec![
        Record::Other(4),
        Record::Description(avcc()),
        Record::Key(unit(0x25)),
        Record::Delta(unit(0x21)),
    ];
    for bytewise in [false, true] {
        assert_eq!(
            read(&chunked(&stream()), bytewise),
            Ok((expected.clone(), true))
        );
        let plain = [
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".as_slice(),
            &stream(),
        ]
        .concat();
        assert_eq!(read(&plain, bytewise), Ok((expected.clone(), false)));
    }
}

#[test]
fn a_response_other_than_200_or_a_bad_record_is_refused() {
    let missing = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
    assert_eq!(
        read(missing, false),
        Err(ReadError::Response("status 404".into()))
    );
    let oversized = [
        b"HTTP/1.1 200 OK\r\n\r\n".as_slice(),
        &((RECORD_LIMIT + 1) as u32).to_be_bytes(),
    ]
    .concat();
    assert!(matches!(read(&oversized, false), Err(ReadError::Stream(_))));
}

#[test]
fn units_become_the_frames_the_daemon_publishes_with_parameter_sets_before_each_keyframe() {
    let mut translate = Translator::default();
    assert_eq!(
        translate.frame(Record::Key(unit(0x25))),
        Err(ReadError::Stream("a unit came before its description"))
    );
    assert_eq!(translate.frame(Record::Description(avcc())), Ok(None));
    assert_eq!(translate.frame(Record::Other(4)), Ok(None));
    let Ok(Some(key)) = translate.frame(Record::Key(unit(0x25))) else {
        panic!("a keyframe after its description is a frame");
    };
    let Ok(Some(delta)) = translate.frame(Record::Delta(unit(0x21))) else {
        panic!("a delta is a frame");
    };
    let Ok(config) = AvcConfig::parse(&avcc()) else {
        panic!("the fixture is a valid avcC");
    };
    let mut parameters = Vec::new();
    for nal in config.sps.iter().chain(config.pps.iter()) {
        parameters.extend_from_slice(&[0, 0, 0, 1]);
        parameters.extend_from_slice(nal);
    }
    let sample = [0, 0, 0, 1, 0x25, 0x88, 0x84, 0, 0, 0, 1, 0x06, 0x05, 0x01];
    assert_eq!(key.payload, [parameters.as_slice(), &sample].concat());
    assert_eq!((key.kind, key.codec, key.flags & 1), (1, 1, 1));
    assert_eq!(key.codec_string, config.codec_string());
    assert!(key.width > 0 && key.height > 0);
    assert_eq!((delta.width, delta.height), (key.width, key.height));
    assert_eq!(
        delta.payload,
        [0, 0, 0, 1, 0x21, 0x88, 0x84, 0, 0, 0, 1, 0x06, 0x05, 0x01]
    );
    assert_eq!((delta.flags & 1, delta.codec_string.as_str()), (0, ""));
}

#[test]
fn only_a_loopback_address_is_ever_read() {
    assert_eq!(
        loopback_url("http://127.0.0.1:3100/sim/stream.avcc"),
        Some((3100, "/sim/stream.avcc".into()))
    );
    assert_eq!(
        loopback_url("http://localhost:8/stream.avcc"),
        Some((8, "/stream.avcc".into()))
    );
    for refused in [
        "http://10.0.0.2:3100/stream.avcc",
        "https://127.0.0.1:3100/stream.avcc",
        "http://127.0.0.1:0/stream.avcc",
        "http://127.0.0.1:3100/a b",
        "http://127.0.0.1.evil:3100/stream.avcc",
    ] {
        assert_eq!(loopback_url(refused), None, "{refused}");
    }
}
