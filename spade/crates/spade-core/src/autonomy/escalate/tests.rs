use super::*;
use crate::autonomy::{CREDENTIALS_REFUSED, Mode};
use crate::effect::{Call, Drive, Effect, Granted, Place};
use crate::gate::Decision;
use crate::tools::Risk;

/// A held write from outside the sandbox, nothing else about it.
fn outside(effect: Option<Effect>) -> Call<'static> {
    Call {
        tool: "app_tool",
        rule: Decision::Ask,
        risk: Risk::Write,
        always: false,
        effect,
        remembered: None,
        place: Place::Unsandboxed(crate::autonomy::Class::Inside),
        tainted: false,
        credentials: false,
        standing: false,
        fits: true,
        granted: Granted::No,
        checkpointed: false,
        target: None,
        drive: Drive::default(),
        mode: Mode::AutoReview,
        remote: false,
        classifier: true,
    }
}

fn asks(line: &str, stopped: Stopped) -> Settled {
    Settled::Ask {
        line: line.to_owned(),
        stopped,
    }
}

/// What a route comes to for the person: asked with a line, refused with a reason, or neither.
fn routed(route: Route) -> Option<Result<String, String>> {
    match route {
        Route::Ask { line, .. } => Some(Ok(line)),
        Route::Refuse(why) => Some(Err(why)),
        Route::Run | Route::Review(_) => None,
    }
}

#[test]
fn what_a_judge_stops_goes_to_the_person_and_only_secrets_and_declined_tools_are_refused() {
    let cases = [
        (
            "reviewer deny",
            Stop::Reviewer("It deletes the person's build."),
            asks(
                "The reviewer stopped this: It deletes the person's build.",
                Stopped::Reviewer,
            ),
        ),
        (
            "reviewer timeout",
            Stop::ReviewerUndecided("The review took too long, so you decide."),
            asks(
                "The review took too long, so you decide.",
                Stopped::Reviewer,
            ),
        ),
        (
            "reviewer unreachable",
            Stop::ReviewerUndecided("The reviewer couldn't be reached, so you decide."),
            asks(
                "The reviewer couldn't be reached, so you decide.",
                Stopped::Reviewer,
            ),
        ),
        (
            "classifier raise",
            Stop::Classifier("It could spend money, so you decide."),
            asks("It could spend money, so you decide.", Stopped::Classifier),
        ),
        (
            "second review objection",
            Stop::SecondReview("The person asked for a draft, not a send"),
            asks(
                "The second review stopped this: The person asked for a draft, not a send.",
                Stopped::SecondReview,
            ),
        ),
        (
            "second review timeout",
            Stop::SecondReviewUndecided("The review took too long, so you decide."),
            asks(
                "The review took too long, so you decide.",
                Stopped::SecondReview,
            ),
        ),
        (
            "incomplete outside",
            Stop::IncompleteOutside,
            asks(INCOMPLETE_OUTSIDE, Stopped::Incomplete),
        ),
        (
            "incomplete at launch",
            Stop::IncompleteAtLaunch,
            asks(INCOMPLETE_AT_LAUNCH, Stopped::Incomplete),
        ),
        (
            "unread at launch",
            Stop::UnreadAtLaunch,
            asks(UNREAD_AT_LAUNCH, Stopped::Unread),
        ),
        (
            "changed while waiting",
            Stop::ChangedAtLaunch,
            asks(CHANGED_AT_LAUNCH, Stopped::Changed),
        ),
        (
            "secret",
            Stop::Secret,
            Settled::Refuse(CREDENTIALS_REFUSED.to_owned()),
        ),
        (
            "declined tool",
            Stop::DeclinedTool,
            Settled::Refuse(crate::effect::DECLINED_TOOL.to_owned()),
        ),
    ];
    for (case, stop, expected) in cases {
        assert_eq!(settle(stop), expected, "{case}");
    }
}

#[test]
fn an_incomplete_reading_outside_the_sandbox_asks_whatever_the_route_and_hard_refusals_stay() {
    let secret = Call {
        credentials: true,
        ..outside(Some(Effect::Network))
    };
    // An app's tool the person declined for the bot: it runs on Spade's side, not as a command.
    let declined = Call {
        remembered: Some(false),
        place: Place::Host,
        ..outside(None)
    };
    let full_access_write = Call {
        mode: Mode::FullAccess,
        ..outside(Some(Effect::WriteLocal))
    };
    let incomplete_line = Some(Ok(INCOMPLETE_OUTSIDE.to_owned()));
    let cases = [
        // Would run on the rules: the person decides.
        (
            "a local write",
            outside(Some(Effect::WriteLocal)),
            incomplete_line.clone(),
        ),
        // Would run with no reviewer in Full access: the person decides there too.
        (
            "full access write",
            full_access_write,
            incomplete_line.clone(),
        ),
        // Would go to the reviewer, who can't read it whole: the person decides.
        (
            "a network write",
            outside(Some(Effect::Network)),
            incomplete_line,
        ),
        // Already the person's: still asked, told both reasons.
        (
            "a payment",
            outside(Some(Effect::Pay)),
            Some(Ok(format!(
                "{} {INCOMPLETE_OUTSIDE}",
                crate::effect::SPENDS
            ))),
        ),
        ("secret", secret, Some(Err(CREDENTIALS_REFUSED.to_owned()))),
        (
            "declined tool",
            declined,
            Some(Err(crate::effect::DECLINED_TOOL.to_owned())),
        ),
    ];
    for (case, call, expected) in cases {
        assert_eq!(
            routed(incomplete(crate::effect::route(call))),
            expected,
            "{case}"
        );
    }
}

#[test]
fn a_secret_and_a_declined_tool_are_refused_by_the_routing_itself_not_put_to_the_person() {
    let secret = Call {
        credentials: true,
        ..outside(Some(Effect::Read))
    };
    // An app's tool the person declined for the bot: it runs on Spade's side, not as a command.
    let declined = Call {
        remembered: Some(false),
        place: Place::Host,
        ..outside(None)
    };
    for (case, call, stop) in [
        ("secret", secret, Stop::Secret),
        ("declined tool", declined, Stop::DeclinedTool),
    ] {
        let Settled::Refuse(why) = settle(stop) else {
            panic!("{case} is put to the person");
        };
        assert_eq!(crate::effect::route(call), Route::Refuse(why), "{case}");
    }
}

#[test]
fn only_a_check_that_couldnt_vouch_for_a_command_is_answered_once() {
    let once: Vec<Stopped> = [
        Stopped::Reviewer,
        Stopped::SecondReview,
        Stopped::Classifier,
        Stopped::Incomplete,
        Stopped::Unread,
        Stopped::Changed,
    ]
    .into_iter()
    .filter(|stopped| stopped.once())
    .collect();
    assert_eq!(
        once,
        [Stopped::Incomplete, Stopped::Unread, Stopped::Changed]
    );
}
