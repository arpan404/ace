use super::*;

fn facts(input_ms: Option<u64>) -> GuardFacts {
    GuardFacts {
        stop_requested: false,
        status: SessionStatus::Active,
        app_active: true,
        ms_since_input: input_ms,
    }
}

#[test]
fn a_switched_user_session_is_unavailable_and_a_lock_screen_from_any_source_is_locked() {
    let unavailable = SessionFacts {
        logind_active: Some(false),
        logind_locked: Some(true),
        ..SessionFacts::default()
    };
    assert_eq!(session_status(&unavailable), SessionStatus::Unavailable);
    for locked in [
        SessionFacts {
            logind_locked: Some(true),
            ..SessionFacts::default()
        },
        SessionFacts {
            screensaver_active: Some(true),
            ..SessionFacts::default()
        },
        SessionFacts {
            locker_running: true,
            ..SessionFacts::default()
        },
    ] {
        assert_eq!(session_status(&locked), SessionStatus::Locked);
    }
    // Nothing reports a lock: unknown facts never read as locked.
    assert_eq!(session_status(&SessionFacts::default()), SessionStatus::Active);
}

#[test]
fn the_persons_stop_wins_over_everything_and_an_unavailable_session_stops_actions() {
    let stopped = GuardFacts {
        stop_requested: true,
        ..facts(None)
    };
    assert_eq!(guard(&stopped, "Calculator", || false).unwrap_err().code, "stopped_by_person");
    let gone = GuardFacts {
        status: SessionStatus::Unavailable,
        ..facts(None)
    };
    assert_eq!(guard(&gone, "Calculator", || false).unwrap_err().code, "session_unavailable");
}

#[test]
fn recent_input_in_the_apps_own_window_refuses_only_a_conflicting_action() {
    let refused = guard(&facts(Some(200)), "Text Editor", || true).unwrap_err();
    assert_eq!(refused.code, "person_active");
    assert!(refused.message.contains("Text Editor"));
    assert!(guard(&facts(Some(200)), "Text Editor", || false).is_ok());
}

#[test]
fn the_focus_is_only_read_when_the_person_may_be_using_the_app() {
    let mut asked = false;
    // Input long ago, an app in the background, a locked screen or no idle information.
    for quiet in [
        facts(Some(RECENT_INPUT_MS)),
        GuardFacts {
            app_active: false,
            ..facts(Some(0))
        },
        GuardFacts {
            status: SessionStatus::Locked,
            ..facts(Some(0))
        },
        facts(None),
    ] {
        assert!(guard(&quiet, "Calculator", || {
            asked = true;
            true
        })
        .is_ok());
    }
    assert!(!asked);
}

#[test]
fn only_actions_where_the_person_is_working_conflict() {
    let theirs = TargetFacts {
        same_window: true,
        ..TargetFacts::default()
    };
    // Keys, typing and menus without an element go to the person's focused control.
    assert!(conflicts_with_person(&theirs));
    // An element: only theirs, or any while their focus is unknown.
    let element = TargetFacts {
        explicit_target: true,
        focus_known: true,
        ..theirs
    };
    assert!(!conflicts_with_person(&element));
    assert!(conflicts_with_person(&TargetFacts {
        contains_focus: true,
        ..element
    }));
    assert!(conflicts_with_person(&TargetFacts {
        focus_known: false,
        ..element
    }));
    // Another window of the app, and a look, never conflict.
    assert!(!conflicts_with_person(&TargetFacts::default()));
    assert!(!conflicts_with_person(&TargetFacts {
        observing: true,
        ..theirs
    }));
}
