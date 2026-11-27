// SPDX-License-Identifier: Apache-2.0
//! Redaction of the two secrets Pi may echo, ported from `session.ts:129`–`:133`.
//! Every frame the wire emits is the redacted text, never the original.

/// The control secret and the lease bearer, replaced in that order exactly as
/// the TypeScript did.
#[derive(Debug, Clone)]
pub struct Redactor {
    control_secret: String,
    lease_bearer: Option<String>,
}

impl Redactor {
    pub fn new(control_secret: String, lease_bearer: Option<String>) -> Redactor {
        Redactor {
            control_secret,
            lease_bearer,
        }
    }

    /// `line.replaceAll(controlSecret, "<ACE_CONTROL>")`, then the lease bearer
    /// the same way when there is one.
    pub fn redact(&self, line: &str) -> String {
        let mut out = line.replace(&self.control_secret, "<ACE_CONTROL>");
        if let Some(bearer) = &self.lease_bearer {
            out = out.replace(bearer, "<ACE_LEASE>");
        }
        out
    }
}
