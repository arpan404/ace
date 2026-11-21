// SPDX-License-Identifier: Apache-2.0

//! `nativeReference`: how a provider resumes a saved session. Pi resumes a file by its identity,
//! `ace-pi:` and the base64url of `{"path","id"}` (`encodeSessionReference` in `@ace/adapter-pi`);
//! every other CLI resumes by session id.

use history_text::js;
use serde_json::{Value, json};

use crate::error::{Error, Result};
use crate::session::Source;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url without padding, as Node's `Buffer.toString("base64url")` writes it.
fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

/// The Pi reference of a session file, refused as `SessionReference.parse` refuses it.
pub fn pi_reference(path: &str, id: &str) -> Result<String> {
    let absolute = std::path::Path::new(path).is_absolute();
    let path_ok = absolute && (1..=8192).contains(&js::length(path));
    if !path_ok || !(1..=128).contains(&js::length(id)) {
        return Err(Error::message(
            "This Pi session cannot be resumed: its saved reference is invalid",
        ));
    }
    let text = serde_json::to_string(&json!({ "path": path, "id": id }))
        .map_err(|e| Error::message(e.to_string()))?;
    Ok(format!("ace-pi:{}", base64url(text.as_bytes())))
}

/// The provider and native id a resumed or imported agent records.
pub fn native_reference(source: &Source) -> Result<Value> {
    let native = if source.summary.provider == "pi" {
        pi_reference(&source.path, &source.summary.native_id)?
    } else {
        source.summary.native_id.clone()
    };
    Ok(json!({ "provider": source.summary.provider, "nativeId": native }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn base64url_matches_node_with_no_padding() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn a_pi_reference_names_the_file_and_session() {
        // Buffer.from('{"path":"/h/s.jsonl","id":"abc"}').toString("base64url")
        assert_eq!(
            pi_reference("/h/s.jsonl", "abc").unwrap(),
            "ace-pi:eyJwYXRoIjoiL2gvcy5qc29ubCIsImlkIjoiYWJjIn0"
        );
        assert!(pi_reference("relative", "abc").is_err());
        assert!(pi_reference("/h/s.jsonl", "").is_err());
    }
}
