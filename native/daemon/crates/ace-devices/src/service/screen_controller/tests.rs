// SPDX-License-Identifier: Apache-2.0
//! Screen and device tools share one lease for a Simulator window
//! (`screen-controller.ts`).
//!
//! `screen-controller.ts` has no test file of its own (behaviour.md §5 lists
//! none), so these cases are the module's only guard.

use super::{Mirror, authorize, mirror, released};
use crate::error::DeviceErrorCode;
use crate::service::lease::{Actor, Controller};
use crate::service::session::Session;

fn held(session: &mut Session, actor: &Actor) {
    session.lease.claim(actor.clone(), 0.0);
}

#[test]
fn no_screen_session_mirrors_nothing() {
    let mut session = Session::new("ios:AAAA");
    assert_eq!(mirror(&mut session, None, 0.0), Ok(Mirror::None));
}

#[test]
fn a_free_device_clears_the_screen_control() {
    let mut session = Session::new("ios:AAAA");
    assert_eq!(
        mirror(&mut session, Some("screen-1"), 0.0),
        Ok(Mirror::Cleared)
    );
}

#[test]
fn a_held_device_mirrors_its_controller_and_ticket() {
    let mut session = Session::new("ios:AAAA");
    let agent = Actor::agent("agent-1", "t1", "a1");
    held(&mut session, &agent);
    assert_eq!(
        mirror(&mut session, Some("screen-1"), 0.0),
        Ok(Mirror::Controlled {
            actor: agent.clone(),
            ticket: 1,
        })
    );
    assert_eq!(
        session.lease.status(0.0).controller,
        Controller::Agent,
        "mirroring re-proves the control, which renews it"
    );
}

#[test]
fn the_screens_guard_reproves_the_ticket() {
    let mut session = Session::new("ios:AAAA");
    let agent = Actor::agent("agent-1", "t1", "a1");
    held(&mut session, &agent);
    let Ok(Mirror::Controlled { actor, ticket }) = mirror(&mut session, Some("screen-1"), 0.0)
    else {
        panic!("a controlled mirror");
    };
    authorize(&mut session.lease, &actor, ticket, 1_000.0).expect("still holds it");

    // The person takes the device: the screen manager's guard fails from then on.
    session.lease.claim(Actor::human("person"), 1_500.0);
    let refused = authorize(&mut session.lease, &actor, ticket, 2_000.0)
        .expect_err("the takeover revoked it");
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);
}

#[test]
fn the_screens_release_lets_go_only_while_it_still_holds_it() {
    let mut session = Session::new("ios:AAAA");
    let agent = Actor::agent("agent-1", "t1", "a1");
    held(&mut session, &agent);
    let Ok(Mirror::Controlled { actor, ticket }) = mirror(&mut session, Some("screen-1"), 0.0)
    else {
        panic!("a controlled mirror");
    };

    assert!(released(&mut session.lease, &actor, ticket, 1_000.0));
    assert_eq!(
        session.lease.status(1_000.0).controller,
        Controller::None,
        "the screen manager letting go releases the device"
    );
    // A second release changes nothing.
    assert!(!released(&mut session.lease, &actor, ticket, 1_000.0));
}

#[test]
fn a_release_after_a_takeover_does_not_touch_the_new_holder() {
    let mut session = Session::new("ios:AAAA");
    let agent = Actor::agent("agent-1", "t1", "a1");
    held(&mut session, &agent);
    let Ok(Mirror::Controlled { actor, ticket }) = mirror(&mut session, Some("screen-1"), 0.0)
    else {
        panic!("a controlled mirror");
    };
    session.lease.claim(Actor::human("person"), 1_000.0);
    assert!(!released(&mut session.lease, &actor, ticket, 2_000.0));
    assert_eq!(
        session.lease.status(2_000.0).controller,
        Controller::Human,
        "the person keeps the device"
    );
}
