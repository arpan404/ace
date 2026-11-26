// SPDX-License-Identifier: Apache-2.0
//! The session's own lifecycle: abandoning before a child exists, and the I/O shell.

use ace_json::json;
use ace_supervisor::peer::Timeout;

use super::settlements;
use crate::session::core::{AcpCore, AcpCoreConfig, AcpEffect, CODE_OPEN_FAILED, CODE_RPC_ERROR};
use crate::session::io::AcpSessionCore;
use crate::session::quirks::AcpSessionQuirks;

/// Abandon ends the call that is still pending and only then drains: without that
/// settlement the facade's open promise would never settle (`io.rs:115`).
#[test]
fn abandon_settles_a_call_still_pending_before_it_drains() {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        "t-abandon",
        "/work",
        AcpSessionQuirks::generic(),
    ));
    let Ok(sent) = core.request("custom/ping", Some(&json!({})), 77, Timeout::Disabled) else {
        panic!("request refused");
    };
    assert!(
        sent.iter()
            .any(|effect| matches!(effect, AcpEffect::Write { .. })),
        "the call is still pending: {sent:?}"
    );

    let effects = core.abandon();
    let settled = settlements(&effects, 77);
    assert_eq!(
        settled.len(),
        1,
        "abandon settles the pending call: {settled:?}"
    );
    assert_eq!(
        settled[0],
        Err((
            CODE_RPC_ERROR.to_owned(),
            "ACP session abandoned before start".to_owned()
        ))
    );
    assert!(matches!(effects.last(), Some(AcpEffect::Drained)));
}

#[test]
fn session_io_shell_publishes_process_start_and_settles_on_abandon() {
    let config = AcpCoreConfig::new("t-io", "/work", AcpSessionQuirks::generic());
    let session = AcpSessionCore::new(config);
    // Starting open before child ports are attached triggers write refusal -> settles once.
    session.start_open(42);
    session.abandon();

    let batch = session.queue().take_batch(64, 1024 * 1024);
    let json = ace_json::ser::to_string(&batch).unwrap_or_default();
    assert!(json.contains("process-start"));
    assert!(json.contains(CODE_OPEN_FAILED));
    assert!(json.contains("\"drained\""));
}
