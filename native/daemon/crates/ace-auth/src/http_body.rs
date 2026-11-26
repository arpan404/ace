// SPDX-License-Identifier: Apache-2.0
//! The access API's JSON bodies (`apps/daemon/src/access-http.ts:37`–`:64`): a capped read that
//! answers `413 Request too large` before a pairing code is redeemed, `400 JSON object
//! required` for a body that isn't JSON, and `None` for the optional body an empty POST sends.

use ace_json::Value;

use crate::error::{AuthError, Result};

/// The cap `body()` applies to every JSON POST, pairing redemption included (`:54`).
pub const BODY_LIMIT: usize = 4_096;
/// The cap `optionalBody()` applies to a body that may be absent (`:41`).
pub const OPTIONAL_BODY_LIMIT: usize = 16_384;

/// Read a required JSON body from the chunks a route received.
pub fn read_body(chunks: &[&[u8]]) -> Result<Value> {
    let text = read_chunks(chunks, BODY_LIMIT)?;
    match text {
        Some(text) => parse(&text),
        // `body()` parses even an empty body, and JSON.parse("") throws.
        None => Err(AuthError::access(400, "JSON object required")),
    }
}

/// Read an optional JSON body: `None` when it is empty after trimming (`optionalBody`).
pub fn read_optional_body(chunks: &[&[u8]]) -> Result<Option<Value>> {
    match read_chunks(chunks, OPTIONAL_BODY_LIMIT)? {
        Some(text) => parse(&text).map(Some),
        None => Ok(None),
    }
}

/// The UTF-8 text of a capped read, or `None` when it holds only whitespace.
fn read_chunks(chunks: &[&[u8]], limit: usize) -> Result<Option<String>> {
    let mut bytes = Vec::new();
    for chunk in chunks {
        if bytes.len() + chunk.len() > limit {
            return Err(AuthError::access(413, "Request too large"));
        }
        bytes.extend_from_slice(chunk);
    }
    let text = String::from_utf8_lossy(&bytes);
    let trimmed =
        text.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    Ok((!trimmed.is_empty()).then(|| trimmed.to_owned()))
}

fn parse(text: &str) -> Result<Value> {
    ace_json::parse(text).map_err(|_| AuthError::access(400, "JSON object required"))
}

#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/remote-boundaries.server.process.test.ts`'s oversized-redemption
    //! case: a body past the cap is refused `413` before the code is taken, so the link still
    //! redeems afterwards, and a malformed or empty body is `400 JSON object required`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{BODY_LIMIT, read_body, read_optional_body};
    use crate::devices::Scope;
    use crate::pairing::PairingTerms;
    use crate::remote_auth::RemoteAuth;
    use crate::{CredentialRuntime, Runtime};

    fn auth() -> (RemoteAuth, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let runtime = CredentialRuntime::new(|| "device-1".to_owned(), |size| vec![1; size]);
        let devices = crate::devices::Devices::open(path.to_str().unwrap(), runtime).unwrap();
        let auth = RemoteAuth::with_memory(
            devices,
            "aa".repeat(32),
            Runtime::new(|| 1_000, || "bb".repeat(32), || "pairing-1".to_owned()),
        );
        (auth, directory)
    }

    #[test]
    fn an_oversized_redemption_body_is_413_and_does_not_consume_its_code() {
        let (mut auth, _home) = auth();
        let issued = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        let padding = format!(
            "{{\"code\":\"{}\",\"name\":\"Phone\",\"padding\":\"{}\"}}",
            issued.code,
            "x".repeat(100 * 1024)
        );
        let error = read_body(&[padding.as_bytes()]).unwrap_err();
        assert_eq!(error.status(), 413);
        assert_eq!(error.message(), "Request too large");
        // The code was never parsed or taken, so the link still pairs.
        let redeemed = auth.redeem(&issued.code, "Phone", None, None).unwrap();
        assert_eq!(redeemed.device.name, "Phone");
    }

    #[test]
    fn a_body_exactly_at_the_cap_is_read_and_one_byte_more_is_refused() {
        let padding = |bytes: usize| vec![b'x'; bytes];
        // At the cap the read happens and the JSON parse is what refuses it; one byte more is
        // refused before any parse.
        let exact = padding(BODY_LIMIT);
        assert_eq!(read_body(&[&exact]).unwrap_err().status(), 400);
        let over = padding(BODY_LIMIT + 1);
        assert_eq!(read_body(&[&over]).unwrap_err().status(), 413);
        // The cap is across chunks, not per chunk.
        let half = padding(BODY_LIMIT / 2 + 1);
        assert_eq!(read_body(&[&half, &half]).unwrap_err().status(), 413);
    }

    #[test]
    fn a_body_that_is_not_json_or_is_empty_names_the_json_it_needs() {
        let error = read_body(&[b"not json"]).unwrap_err();
        assert_eq!(error.status(), 400);
        assert_eq!(error.message(), "JSON object required");
        assert_eq!(read_body(&[]).unwrap_err().status(), 400);
        assert_eq!(read_optional_body(&[]).unwrap(), None);
        assert_eq!(read_optional_body(&[b"  \n "]).unwrap(), None);
        assert!(
            read_optional_body(&[b"{\"op\":\"pause\"}"])
                .unwrap()
                .is_some()
        );
    }
}
