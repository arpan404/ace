// SPDX-License-Identifier: Apache-2.0

mod common;

use common::Fixture;
use files_io::{ReadRange, read};

fn range(offset: u64, length: u64) -> ReadRange {
    ReadRange {
        offset,
        length,
        max_size: None,
    }
}

#[test]
fn reads_a_range() {
    let fixture = Fixture::new();
    let content = "abcdefghij".repeat(10).into_bytes();
    fixture.write("bytes.txt", &content);

    let middle = read(fixture.root(), "bytes.txt", range(10, 20)).expect("read the middle");
    assert_eq!(middle.bytes, content[10..30]);
    assert_eq!(middle.size, content.len() as u64);
    assert_eq!(middle.version, fixture.version("bytes.txt"));
    assert!(!middle.binary);
    assert!(!middle.bom);
    assert!(!middle.eof);
    assert_eq!(middle.encoding, "UTF-8");

    let tail = read(fixture.root(), "bytes.txt", range(90, 20)).expect("read the tail");
    assert_eq!(tail.bytes, content[90..]);
    assert!(tail.eof);

    let past_end = read(fixture.root(), "bytes.txt", range(100, 10)).expect("read past the end");
    assert!(past_end.bytes.is_empty());
    assert!(past_end.eof);
}

#[test]
fn detects_utf16_bom_and_latin1() {
    let fixture = Fixture::new();
    let text = "grüße aus köln";
    let mut utf16 = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    fixture.write("utf16.txt", &utf16);

    let utf16_read = read(fixture.root(), "utf16.txt", range(0, 1024)).expect("read UTF-16");
    assert!(utf16_read.bom);
    assert!(!utf16_read.binary, "UTF-16 text is full of NUL bytes");
    assert_eq!(utf16_read.encoding, "UTF-16LE");
    assert_eq!(utf16_read.bytes, utf16);
    assert!(utf16_read.eof);

    let latin1 = b"Ma\xDFnahme: Gr\xFC\xDFe aus K\xF6ln, \xE7a va tr\xE8s bien, ma\xF1ana ser\xE1 otro d\xEDa. \xC9l\xE9gant, n\xE9?";
    fixture.write("latin1.txt", latin1);
    let latin1_read = read(fixture.root(), "latin1.txt", range(0, 1024)).expect("read Latin-1");
    assert!(!latin1_read.bom);
    assert!(!latin1_read.binary);
    assert_eq!(latin1_read.encoding, "windows-1252");
    assert_eq!(latin1_read.bytes, latin1);
}

#[test]
fn utf8_sample_cut_mid_character_is_still_utf8() {
    let fixture = Fixture::new();
    let content = "€".repeat(4_000);
    fixture.write("euro.txt", content.as_bytes());
    let read = read(fixture.root(), "euro.txt", range(0, 16)).expect("read");
    assert_eq!(read.encoding, "UTF-8");
    assert!(!read.binary);
}

#[test]
fn binary_file_is_flagged() {
    let fixture = Fixture::new();
    fixture.write(
        "image.bin",
        &[0x89, b'P', b'N', b'G', 0x00, 0x1a, 0x0a, 0xff],
    );
    let image = read(fixture.root(), "image.bin", range(0, 1024)).expect("read binary");
    assert!(image.binary);
    assert!(!image.bom);

    let mut late_nul = vec![b'a'; 9_000];
    late_nul[8_500] = 0;
    fixture.write("late.txt", &late_nul);
    let late = read(fixture.root(), "late.txt", range(0, 8)).expect("read past the sample");
    assert!(!late.binary, "only the first 8 KiB decide");
}

#[test]
fn max_size_returns_no_bytes() {
    let fixture = Fixture::new();
    let content = "0123456789".repeat(5);
    fixture.write("big.txt", content.as_bytes());

    let limited = read(
        fixture.root(),
        "big.txt",
        ReadRange {
            offset: 0,
            length: 100,
            max_size: Some(49),
        },
    )
    .expect("read a file over the limit");
    assert!(limited.bytes.is_empty());
    assert_eq!(limited.size, 50);
    assert!(!limited.eof);

    let allowed = read(
        fixture.root(),
        "big.txt",
        ReadRange {
            offset: 0,
            length: 100,
            max_size: Some(50),
        },
    )
    .expect("read a file at the limit");
    assert_eq!(allowed.bytes, content.as_bytes());
    assert!(allowed.eof);
}

#[test]
fn reading_a_folder_is_not_a_file() {
    let fixture = Fixture::new();
    fixture.write("folder/inside.txt", b"text\n");
    let error =
        read(fixture.root(), "folder", range(0, 10)).expect_err("a folder has no bytes to read");
    assert_eq!(error.code(), "NOT_FILE");
}
