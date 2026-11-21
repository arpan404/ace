//! `ace org audit export` and `ace org audit verify` (ADR 0206 §4.2): the host's log as JSON
//! Lines with its chain and checkpoints, and the offline check of such a file against the key
//! the host registered.

use spade_core::org::audit::{self, Line};
use spade_store::{Store, StoreError};

use super::{Binding, signer};

/// Entries read from the store per page.
const PAGE: usize = 500;

/// The log from the first entry written at or after `from_ms` through the last one written at
/// or before `to_ms`, as JSON Lines: a header naming the organization, the host and its audit
/// key, then each entry, each checkpoint right after the entry it covers.
pub fn export(
    store: &Store,
    binding: &Binding,
    key: &str,
    from_ms: i64,
    to_ms: i64,
) -> Result<String, StoreError> {
    let header = Line::Header {
        org: binding.org.clone(),
        host: binding.host.clone(),
        key: key.to_owned(),
    };
    let mut out = line(&header);
    let Some(first) = store.audit_seq_at(from_ms)? else {
        return Ok(out);
    };
    let mut after = first - 1;
    loop {
        let page = store.audit_entries(after, PAGE)?;
        let Some(last) = page.last().map(|chained| chained.seq) else {
            break;
        };
        let checkpoints = store.audit_checkpoints(after + 1, last)?;
        let mut done = false;
        for chained in page {
            if chained.entry.occurred_at > to_ms {
                done = true;
                break;
            }
            let seq = chained.seq;
            out.push_str(&line(&Line::Entry(chained)));
            for checkpoint in checkpoints.iter().filter(|c| c.count == seq) {
                out.push_str(&line(&Line::Checkpoint(checkpoint.clone())));
            }
        }
        if done {
            break;
        }
        after = last;
    }
    Ok(out)
}

fn line(line: &Line) -> String {
    let mut text = serde_json::to_string(line).unwrap_or_default();
    text.push('\n');
    text
}

/// What `ace org audit verify` says of `text`, checked against `key` (the host's registered
/// audit key, base64url): one line, and whether it verified.
pub fn verify(text: &str, key: &str) -> (bool, String) {
    let signed = |message: &[u8], signature: &str| signer::signed_by(key, message, signature);
    match audit::verify(text, &signed) {
        Ok(verified) => (
            true,
            format!(
                "Verified: {} entries, {} checkpoints; {} after the last checkpoint.",
                verified.entries, verified.checkpoints, verified.unsigned
            ),
        ),
        Err(broken) => (
            false,
            format!("Not verified: line {}: {}.", broken.line, broken.why),
        ),
    }
}
