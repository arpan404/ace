// SPDX-License-Identifier: Apache-2.0

//! How a file's bytes become text: a BOM first, then UTF-8, then a chardetng guess.

/// How much of a file decides its encoding and whether an editor should open it as text.
pub(crate) const SAMPLE_BYTES: u64 = 8 * 1024;

/// What a sample of a file says about reading it as text.
pub(crate) struct Detection {
    /// `encoding_rs`'s canonical name, such as `UTF-8` or `windows-1252`.
    pub(crate) encoding: &'static str,
    /// The sample starts with a byte-order mark.
    pub(crate) bom: bool,
    /// A NUL byte appears where text would not have one.
    pub(crate) binary: bool,
}

/// The encoding of the file's first bytes, and whether it looks binary.
///
/// A NUL byte means binary unless the BOM already said UTF-16, whose text is full of them.
/// A binary file is labelled UTF-8 because nothing is known about its contents.
pub(crate) fn detect(sample: &[u8]) -> Detection {
    if let Some(encoding) = bom(sample) {
        return Detection {
            encoding: encoding.name(),
            bom: true,
            binary: false,
        };
    }
    if sample.contains(&0) {
        return Detection {
            encoding: encoding_rs::UTF_8.name(),
            bom: false,
            binary: true,
        };
    }
    let encoding = if is_utf8(sample) {
        encoding_rs::UTF_8
    } else {
        guess(sample)
    };
    Detection {
        encoding: encoding.name(),
        bom: false,
        binary: false,
    }
}

fn bom(sample: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    if sample.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some(encoding_rs::UTF_8)
    } else if sample.starts_with(&[0xFF, 0xFE]) {
        Some(encoding_rs::UTF_16LE)
    } else if sample.starts_with(&[0xFE, 0xFF]) {
        Some(encoding_rs::UTF_16BE)
    } else {
        None
    }
}

/// A sample can stop in the middle of a character; that is still valid UTF-8.
fn is_utf8(sample: &[u8]) -> bool {
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none(),
    }
}

/// The legacy encoding chardetng thinks fits best. UTF-8 is out because it was already ruled out,
/// so the detector is not allowed to guess it back.
fn guess(sample: &[u8]) -> &'static encoding_rs::Encoding {
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(sample, true);
    detector.guess(None, false)
}
