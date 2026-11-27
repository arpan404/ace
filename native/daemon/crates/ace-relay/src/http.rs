// SPDX-License-Identifier: Apache-2.0
//! HTTP ace's hosted relay forwards (`apps/daemon/src/relay-http.ts`): the outside MCP endpoint and
//! automations' webhooks, each with its own setting read for every request. With both off the
//! relay answers 404 without reaching a handler; a request for the one that is off gets 404 here.

/// Where automations' webhooks live under a relay prefix (`hooksPath`).
pub const HOOKS_PATH: &str = "/hooks/";

/// Which handler a relayed request goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayHttpTarget {
    Webhooks,
    Mcp,
    /// `notServed`: a 404, the relay's answer while nothing is on.
    NotFound,
}

/// Whether the relay path serves anything at all from this daemon right now.
pub fn relay_http_enabled(webhooks: bool, relay_mcp: bool) -> bool {
    webhooks || relay_mcp
}

/// The handler a request path takes, given the public prefix the relay forwards under and each
/// feature's setting for this request. A webhook path never falls through to MCP: it answers 404
/// when webhooks are off, even with MCP on.
pub fn relay_http_target(
    path: &str,
    prefix: &str,
    webhooks: bool,
    relay_mcp: bool,
) -> RelayHttpTarget {
    if path.starts_with(&format!("{prefix}{HOOKS_PATH}")) {
        return if webhooks {
            RelayHttpTarget::Webhooks
        } else {
            RelayHttpTarget::NotFound
        };
    }
    if !relay_mcp {
        return RelayHttpTarget::NotFound;
    }
    RelayHttpTarget::Mcp
}

#[cfg(test)]
mod tests {
    //! `relay-http.ts` has no test file of its own; these pin the routing it documents.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{RelayHttpTarget, relay_http_enabled, relay_http_target};

    const PREFIX: &str = "/m/ABCD";

    #[test]
    fn either_feature_turns_the_relay_path_on_and_neither_answers_404() {
        assert!(!relay_http_enabled(false, false));
        assert!(relay_http_enabled(true, false));
        assert!(relay_http_enabled(false, true));
        assert!(relay_http_enabled(true, true));
    }

    #[test]
    fn a_webhook_path_goes_to_webhooks_and_a_disabled_one_is_404_even_with_mcp_on() {
        let path = format!("{PREFIX}/hooks/hook-1");
        assert_eq!(
            relay_http_target(&path, PREFIX, true, true),
            RelayHttpTarget::Webhooks
        );
        assert_eq!(
            relay_http_target(&path, PREFIX, false, true),
            RelayHttpTarget::NotFound
        );
        // Another prefix's hooks path is not this daemon's.
        assert_eq!(
            relay_http_target("/m/OTHER/hooks/hook-1", PREFIX, true, true),
            RelayHttpTarget::Mcp
        );
    }

    #[test]
    fn the_mcp_endpoint_is_404_while_its_setting_is_off() {
        let path = format!("{PREFIX}/mcp");
        assert_eq!(
            relay_http_target(&path, PREFIX, false, true),
            RelayHttpTarget::Mcp
        );
        assert_eq!(
            relay_http_target(&path, PREFIX, true, false),
            RelayHttpTarget::NotFound
        );
        assert_eq!(
            relay_http_target(&path, PREFIX, false, false),
            RelayHttpTarget::NotFound
        );
    }
}
