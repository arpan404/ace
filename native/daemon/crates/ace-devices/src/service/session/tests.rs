// SPDX-License-Identifier: Apache-2.0
//! `createSession`'s starting values (`session.ts`).
//!
//! `session.ts` has no test file of its own (behaviour.md §5 lists none), so
//! this case is the module's only guard.

use super::{Lifecycle, Session};
use crate::service::lease::Controller;

#[test]
fn a_new_session_starts_idle_and_unbound() {
    let mut session = Session::new("ios:AAAA");
    assert_eq!(session.device_id, "ios:AAAA");
    assert_eq!(session.lifecycle, Lifecycle::Idle);
    assert_eq!(session.thread_id, None);
    assert_eq!(session.pending(), 0, "no input waits");
    assert_eq!(session.lease.status(0.0).controller, Controller::None);
    assert!(!session.changing_binding);
    assert_eq!(session.binding_epoch, 0);
    assert_eq!(session.control_revision, 0);
    assert_eq!(session.activity_sequence, 0);
    assert_eq!(session.completed, None);
    assert_eq!(session.recording_artifact, None);
}
