// SPDX-License-Identifier: Apache-2.0
//! Issuing a pairing link (`pairing-issue.ts`): the connection, the request, the creator's
//! authority, the person's standing, and the URL the person opens.

use std::collections::HashSet;

use crate::devices::Scope;
use crate::error::{AuthError, Result};
use crate::pairing::{IssuedPairing, PairingTerms, scope_label};
use crate::remote_auth::RemoteAuth;

pub fn unique_scopes(scopes: &[Scope]) -> Vec<Scope> {
    let mut seen = HashSet::new();
    scopes
        .iter()
        .copied()
        .filter(|scope| seen.insert(*scope))
        .collect()
}

/// Issue a pairing link (`pairing-issue.ts:43`): the connection, the request, the creator's
/// authority, and the URL the person opens.
pub fn issue_pairing(
    auth: &mut RemoteAuth,
    connection: Option<&crate::pairing::PairingConnection>,
    input: Option<&ace_json::Value>,
    holds: impl Fn(Scope) -> bool,
    person: bool,
    app: Option<&str>,
) -> Result<IssuedPairing> {
    let Some(connection) = connection else {
        return Err(AuthError::access(
            409,
            "Turn on remote access in Settings, then choose LAN or Tailscale to pair.",
        ));
    };
    let request = input
        .and_then(crate::pairing::PairingRequest::parse)
        .ok_or_else(|| AuthError::access(400, "Invalid scopes"))?;
    let scopes = unique_scopes(&request.scopes);
    if let Some(missing) = RemoteAuth::missing_scope(&scopes, holds) {
        return Err(AuthError::access(
            403,
            format!(
                "You can't grant {}: this device doesn't have it.",
                scope_label(missing)
            ),
        ));
    }
    let terms = PairingTerms {
        label: request.label.clone(),
        ttl_ms: request.ttl_ms,
        device_ttl_ms: request.device_ttl_ms,
        person,
    };
    let issued = auth.pairing(&scopes, &terms)?;
    let url = crate::pairing::pairing_link_url(connection, &issued.code, &scopes, app);
    Ok(IssuedPairing {
        id: issued.id,
        url,
        code: issued.code,
        expires_at: issued.expires_at,
    })
}

#[cfg(test)]
mod tests {
    //! Ported cases live beside the methods they prove; see each file's header for its
    //! TypeScript source.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::issue_pairing;
    use crate::devices::Scope;
    use crate::pairing::{PairingConnection, PairingTerms};
    use crate::remote_auth::support::Home;

    #[test]
    fn a_device_cannot_grant_projects_or_accounts_it_does_not_hold() {
        let home = Home::new();
        let mut auth = home.memory();
        let request = ace_json::parse("{\"scopes\":[\"read\",\"accounts\"]}").unwrap();
        let error = issue_pairing(
            &mut auth,
            Some(&PairingConnection::Direct {
                origin: "https://host:4243".to_owned(),
                fingerprint: "a".repeat(64),
                also_relay: None,
            }),
            Some(&request),
            |scope| scope == Scope::Read,
            false,
            None,
        )
        .unwrap_err();
        assert_eq!(error.status(), 403);
        assert_eq!(
            error.message(),
            "You can't grant Accounts: this device doesn't have it."
        );
        // The host token holds every scope.
        let issued = issue_pairing(
            &mut auth,
            Some(&PairingConnection::Direct {
                origin: "https://host:4243".to_owned(),
                fingerprint: "a".repeat(64),
                also_relay: None,
            }),
            Some(&ace_json::parse("{\"scopes\":[\"projects\",\"accounts\"]}").unwrap()),
            |_| true,
            false,
            None,
        )
        .unwrap();
        let redeemed = auth.redeem(&issued.code, "Desk", None, None).unwrap();
        assert_eq!(
            redeemed.device.scopes,
            vec![Scope::Projects, Scope::Accounts]
        );
    }

    #[test]
    fn no_connection_or_an_invalid_request_is_refused_with_its_own_words() {
        let home = Home::new();
        let mut auth = home.memory();
        let error = issue_pairing(&mut auth, None, None, |_| true, false, None).unwrap_err();
        assert_eq!(error.status(), 409);
        assert_eq!(
            error.message(),
            "Turn on remote access in Settings, then choose LAN or Tailscale to pair."
        );
        let connection = PairingConnection::Direct {
            origin: "https://host:4243".to_owned(),
            fingerprint: "a".repeat(64),
            also_relay: None,
        };
        // Only the offered lifetimes are accepted.
        let request = ace_json::parse("{\"scopes\":[\"read\"],\"ttlMs\":123}").unwrap();
        let error = issue_pairing(
            &mut auth,
            Some(&connection),
            Some(&request),
            |_| true,
            false,
            None,
        )
        .unwrap_err();
        assert_eq!(error.status(), 400);
        assert_eq!(error.message(), "Invalid scopes");
        // Desktop and user-browser can't be granted by a link.
        let error = auth
            .pairing(&[Scope::Desktop], &PairingTerms::default())
            .unwrap_err();
        assert_eq!(error.status(), 403);
        assert_eq!(error.message(), "Desktop credentials are local only");
    }
}
