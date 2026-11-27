// SPDX-License-Identifier: Apache-2.0
//! A devices channel's access rules (`bridge.ts`): who may speak, whose thread a
//! device may be seen from, and the request budget.
//!
//! `bridge-welcome` (a) proves the channel end to end; these cases cover the
//! decisions beside it.

use super::{
    ACCESS_REVOKED, MAX_PENDING_REQUESTS, Peer, RequestFacts, THREAD_ACCESS_DENIED,
    TOO_MANY_REQUESTS, UNKNOWN_AGENT, access, check_request, device_access,
};

fn readable(thread: &str) -> bool {
    thread == "t1"
}

fn known_agent(thread: &str, agent: &str) -> bool {
    thread == "t1" && agent == "a1"
}

fn peer() -> Peer<'static> {
    Peer {
        authorized: true,
        can_read_thread: &readable,
        agent_exists: &known_agent,
    }
}

fn facts() -> RequestFacts<'static> {
    RequestFacts::default()
}

#[test]
fn a_closed_or_revoked_channel_says_nothing() {
    assert_eq!(access(true, true), Err(String::from(ACCESS_REVOKED)));
    assert_eq!(access(false, false), Err(String::from(ACCESS_REVOKED)));
    assert_eq!(access(false, true), Ok(()));
}

#[test]
fn a_device_on_a_thread_this_connection_cannot_read_is_refused() {
    assert_eq!(device_access(false, &peer(), Some("t1")), Ok(()));
    assert_eq!(
        device_access(false, &peer(), Some("t2")),
        Err(String::from(THREAD_ACCESS_DENIED))
    );
    // A device nobody took is every connection's to see.
    assert_eq!(device_access(false, &peer(), None), Ok(()));
    // A revoked connection is refused before the thread is even asked.
    let revoked = Peer {
        authorized: false,
        ..peer()
    };
    assert_eq!(
        device_access(false, &revoked, Some("t2")),
        Err(String::from(ACCESS_REVOKED))
    );
}

#[test]
fn a_channel_refuses_its_thirty_third_request() {
    let at_cap = RequestFacts {
        pending: MAX_PENDING_REQUESTS,
        ..facts()
    };
    assert_eq!(
        check_request(false, &peer(), &at_cap),
        Err(String::from(TOO_MANY_REQUESTS))
    );
    let under = RequestFacts {
        pending: MAX_PENDING_REQUESTS - 1,
        ..facts()
    };
    assert_eq!(check_request(false, &peer(), &under), Ok(()));
}

#[test]
fn a_request_for_an_unknown_agent_is_refused() {
    let known = RequestFacts {
        controller_agent: Some(("t1", "a1")),
        ..facts()
    };
    assert_eq!(check_request(false, &peer(), &known), Ok(()));
    let unknown = RequestFacts {
        controller_agent: Some(("t1", "a9")),
        ..facts()
    };
    assert_eq!(
        check_request(false, &peer(), &unknown),
        Err(String::from(UNKNOWN_AGENT))
    );
    // Missing ids are unknown too, as the TypeScript's `!operation.threadId` is.
    let missing = RequestFacts {
        controller_agent: Some(("", "a1")),
        ..facts()
    };
    assert_eq!(
        check_request(false, &peer(), &missing),
        Err(String::from(UNKNOWN_AGENT))
    );
}

#[test]
fn a_request_naming_an_unreadable_thread_is_refused() {
    let other = RequestFacts {
        thread_id: Some("t2"),
        ..facts()
    };
    assert_eq!(
        check_request(false, &peer(), &other),
        Err(String::from("Thread access denied"))
    );
    let own = RequestFacts {
        thread_id: Some("t1"),
        ..facts()
    };
    assert_eq!(check_request(false, &peer(), &own), Ok(()));
}

#[test]
fn a_request_naming_a_device_checks_its_thread_too() {
    let taken = RequestFacts {
        device_id: Some("ios:AAAA"),
        bound_thread: Some("t2"),
        ..facts()
    };
    assert_eq!(
        check_request(false, &peer(), &taken),
        Err(String::from(THREAD_ACCESS_DENIED))
    );
    let free = RequestFacts {
        device_id: Some("ios:AAAA"),
        bound_thread: None,
        ..facts()
    };
    assert_eq!(check_request(false, &peer(), &free), Ok(()));
}
