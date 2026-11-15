use serde_json::{Value, json};
use spade_models::Message;

use super::*;
use crate::event::{Call, Known, ReplyEnd, Tokens};
use crate::turn::{Next, Status, needs_reply, next_step};

/// Unwraps in tests, which may panic.
trait Sure<T> {
    fn sure(self) -> T;
}

impl<T> Sure<T> for Option<T> {
    fn sure(self) -> T {
        match self {
            Some(value) => value,
            None => panic!("expected a value"),
        }
    }
}

impl<T, E: std::fmt::Debug> Sure<T> for Result<T, E> {
    fn sure(self) -> T {
        match self {
            Ok(value) => value,
            Err(error) => panic!("expected success, got {error:?}"),
        }
    }
}

trait Refusal {
    fn refusal(self) -> String;
}

impl<T: std::fmt::Debug> Refusal for Result<T, String> {
    fn refusal(self) -> String {
        match self {
            Ok(value) => panic!("expected a refusal, got {value:?}"),
            Err(why) => why,
        }
    }
}

fn ask(arguments: Value) -> Ask {
    parse(&arguments).sure()
}

fn refused(arguments: Value) -> String {
    parse(&arguments).refusal()
}

fn questions(arguments: Value) -> Vec<Question> {
    ask(json!({ "questions": [arguments] })).questions
}

fn k(known: Known) -> Event {
    Event::Known(known)
}

fn step(reply: &str, calls: &[(&str, Value)]) -> Event {
    k(Known::StepFinished {
        reply: reply.into(),
        text: String::new(),
        calls: calls
            .iter()
            .map(|(id, arguments)| Call {
                id: (*id).into(),
                name: "ask_user".into(),
                arguments: arguments.clone(),
            })
            .collect(),
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: None,
    })
}

fn asked(reply: &str, call_id: &str, arguments: Value) -> Event {
    let ask = ask(arguments);
    k(Known::QuestionAsked {
        reply: reply.into(),
        call_id: call_id.into(),
        question: ask.summary(),
        questions: ask.questions,
    })
}

fn finished(reply: &str, call_id: &str, content: &str) -> Event {
    k(Known::ToolFinished {
        reply: reply.into(),
        call_id: call_id.into(),
        name: "ask_user".into(),
        content: content.into(),
        is_error: false,
        uncertain: false,
        images: Vec::new(),
        untrusted: false,
    })
}

fn reply_finished(reply: &str) -> Event {
    k(Known::ReplyFinished {
        reply: reply.into(),
        text: "ok".into(),
        input_tokens: None,
        output_tokens: None,
        cost_micros: 0,
    })
}

fn seat() -> Value {
    json!({ "questions": [{ "prompt": "Window or aisle?", "kind": "choice",
        "options": [{ "label": "Window" }, { "label": "Aisle", "detail": "Easier to get out" }],
        "other": true }] })
}

fn status(events: &[Event]) -> Option<Status> {
    match next_step(events) {
        Next::Calls { calls, .. } => calls.first().map(|p| p.status),
        _ => None,
    }
}

#[test]
fn every_kind_is_taken_with_its_own_fields_and_the_old_form_is_one_text_question() {
    let all = ask(json!({ "questions": [
        { "prompt": "Any notes?", "kind": "text", "placeholder": "Optional" },
        { "id": "seat", "prompt": "Seat?", "kind": "choice", "options": ["Window", "Aisle"] },
        { "prompt": "Extras?", "kind": "choices", "options": ["Bag", "Meal", "Wifi"], "max": 2 },
        { "prompt": "Book it?", "kind": "confirm" },
        { "prompt": "Nights?", "kind": "number", "min": 1, "max": 14, "unit": "nights" },
    ] }));
    let kinds: Vec<&str> = all.questions.iter().map(|q| q.kind.name()).collect();
    assert_eq!(kinds, ["text", "choice", "choices", "confirm", "number"]);
    assert!(all.wait);
    assert_eq!(
        all.summary(),
        "Any notes?\nSeat?\nExtras?\nBook it?\nNights?"
    );

    let old = ask(json!({ "question": "  Which city?  " }));
    assert_eq!(
        old.questions,
        vec![Question {
            id: None,
            prompt: "Which city?".into(),
            kind: Kind::Text { placeholder: None },
        }]
    );
    assert!(!ask(json!({ "question": "Later?", "wait": false })).wait);
    let date = questions(json!({ "prompt": "When?", "kind": "date", "time": true }));
    assert_eq!(date[0].kind, Kind::Date { time: true });
}

#[test]
fn arguments_that_break_a_rule_are_refused_saying_which() {
    let unknown = refused(json!({ "questions": [{ "prompt": "Pick", "kind": "slider" }] }));
    assert!(unknown.contains("no kind \"slider\""), "{unknown}");
    let field =
        refused(json!({ "questions": [{ "prompt": "Ok?", "kind": "confirm", "options": [] }] }));
    assert!(field.contains("no field `options`"), "{field}");
    let few =
        refused(json!({ "questions": [{ "prompt": "Pick", "kind": "choice", "options": ["A"] }] }));
    assert!(
        few.starts_with("Question 1:") && few.contains("2 to 10"),
        "{few}"
    );
    let twice = refused(json!({ "questions": [{ "prompt": "Pick", "kind": "choice",
        "options": ["A", "a"] }] }));
    assert!(twice.contains("two options"), "{twice}");
    let bounds = refused(json!({ "questions": [{ "prompt": "Pick", "kind": "choices",
        "options": ["A", "B"], "min": 2, "max": 1 }] }));
    assert!(bounds.contains("`min` is more than `max`"), "{bounds}");
    let many: Vec<Value> = (0..6)
        .map(|i| json!({ "prompt": format!("Q{i}"), "kind": "confirm" }))
        .collect();
    assert!(refused(json!({ "questions": many })).contains("1 to 5"));
    assert!(refused(json!({ "questions": [{ "prompt": "No kind" }] })).contains("`kind`"));
    assert!(refused(json!({})).contains("`questions`"));
    assert!(refused(json!({ "question": "Ok?", "wait": "no" })).contains("`wait`"));
    let ids = refused(json!({ "questions": [
        { "id": "a", "prompt": "One", "kind": "confirm" },
        { "id": "a", "prompt": "Two", "kind": "confirm" }] }));
    assert!(ids.contains("unique"), "{ids}");
}

#[test]
fn each_kinds_answer_is_checked_and_refusals_name_the_question() {
    let card = ask(json!({ "questions": [
        { "prompt": "Seat?", "kind": "choice", "options": ["Window", "Aisle"] },
        { "prompt": "Extras?", "kind": "choices", "options": ["Bag", "Meal", "Wifi"], "max": 2 },
        { "prompt": "Nights?", "kind": "number", "min": 1, "max": 14 },
        { "prompt": "Book it?", "kind": "confirm" },
        { "prompt": "When?", "kind": "date" },
    ] }))
    .questions;
    let fine = json!(["window", ["Wifi", "bag"], 3.0, true, "2026-02-28"]);
    let stored = check_answers(&card, fine.as_array().sure()).sure();
    assert_eq!(
        Value::Array(stored),
        json!(["Window", ["Bag", "Wifi"], 3, true, "2026-02-28"]),
        "labels as the bot wrote them, in option order, a whole number without a fraction"
    );

    let with = |at: usize, answer: Value| {
        let mut answers = fine.as_array().sure().clone();
        answers[at] = answer;
        check_answers(&card, &answers).refusal()
    };
    let unknown = with(0, json!("Middle"));
    assert!(unknown.starts_with("Question 1:") && unknown.contains("not one of its options"));
    let too_many = with(1, json!(["Bag", "Meal", "Wifi"]));
    assert!(
        too_many.starts_with("Question 2:") && too_many.contains("pick 1 to 2"),
        "{too_many}"
    );
    assert!(with(1, json!([])).contains("pick 1 to 2"));
    assert!(with(1, json!(["Bag", "bag"])).contains("twice"));
    let range = with(2, json!(15));
    assert!(
        range.starts_with("Question 3:") && range.contains("above the most"),
        "{range}"
    );
    assert!(with(2, json!(0)).contains("below the least"));
    let missing = with(3, Value::Null);
    assert!(missing.starts_with("Question 4:") && missing.contains("no answer"));
    assert!(with(4, json!("2026-02-30")).contains("a date"));
    assert!(
        check_answers(&card, &[json!("Window")])
            .refusal()
            .contains("one answer per question")
    );
}

#[test]
fn dates_and_date_times_are_iso_8601() {
    let day = questions(json!({ "prompt": "Day?", "kind": "date" }));
    let at = questions(json!({ "prompt": "When?", "kind": "date", "time": true }));
    assert!(
        check_answers(&day, &[json!("2028-02-29")]).is_ok(),
        "a leap day"
    );
    assert!(check_answers(&day, &[json!("2027-02-29")]).is_err());
    assert!(
        check_answers(&day, &[json!("2026-11-15T09:30")]).is_err(),
        "no time asked"
    );
    for fine in [
        "2026-11-15T09:30",
        "2026-11-15T09:30:05",
        "2026-11-15T09:30Z",
        "2026-11-15T09:30+05:45",
    ] {
        assert!(check_answers(&at, &[json!(fine)]).is_ok(), "{fine}");
    }
    for wrong in [
        "2026-11-15",
        "2026-11-15T24:00",
        "2026-11-15T9:30",
        "tomorrow",
    ] {
        assert!(check_answers(&at, &[json!(wrong)]).is_err(), "{wrong}");
    }
}

#[test]
fn other_text_is_taken_only_where_the_question_allows_it() {
    let open = questions(
        json!({ "prompt": "Seat?", "kind": "choice", "options": ["Window", "Aisle"], "other": true }),
    );
    assert_eq!(
        check_answers(&open, &[json!("Exit row")]).sure(),
        vec![json!("Exit row")]
    );
    let extras = questions(
        json!({ "prompt": "Extras?", "kind": "choices", "options": ["Bag", "Meal"], "other": true }),
    );
    assert_eq!(
        check_answers(&extras, &[json!(["Lounge", "Meal"])]).sure(),
        vec![json!(["Meal", "Lounge"])],
        "own text after the options"
    );
    assert!(
        check_answers(&extras, &[json!(["Lounge", "Spa"])]).is_err(),
        "one own answer"
    );
}

#[test]
fn a_typed_message_stands_for_a_single_text_or_open_choice_question_only() {
    let text = questions(json!({ "prompt": "City?", "kind": "text" }));
    assert_eq!(from_message(&text, " Lisbon "), Some(vec![json!("Lisbon")]));
    let open = questions(
        json!({ "prompt": "Seat?", "kind": "choice", "options": ["Window", "Aisle"], "other": true }),
    );
    assert_eq!(from_message(&open, "aisle"), Some(vec![json!("Aisle")]));
    assert_eq!(
        from_message(&open, "Exit row please"),
        Some(vec![json!("Exit row please")])
    );
    let closed =
        questions(json!({ "prompt": "Seat?", "kind": "choice", "options": ["Window", "Aisle"] }));
    assert_eq!(from_message(&closed, "aisle"), Some(vec![json!("Aisle")]));
    assert_eq!(from_message(&closed, "whatever is cheaper"), None);
    let extras = questions(
        json!({ "prompt": "Extras?", "kind": "choices", "options": ["Bag", "Meal"], "other": true }),
    );
    assert_eq!(
        from_message(&extras, "Lounge"),
        Some(vec![json!(["Lounge"])])
    );
    let confirm = questions(json!({ "prompt": "Ok?", "kind": "confirm" }));
    assert_eq!(
        from_message(&confirm, "yes"),
        None,
        "the reply to the whole card"
    );
    let two = ask(
        json!({ "questions": [{ "prompt": "A?", "kind": "text" }, { "prompt": "B?", "kind": "text" }] }),
    );
    assert_eq!(from_message(&two.questions, "both"), None);
}

#[test]
fn a_waiting_card_answered_in_the_card_resumes_the_call_with_each_prompt_and_answer() {
    let mut events = vec![
        Event::user_message("Book me a seat"),
        Event::reply_started("r1", "m"),
        step("r1", &[("q1", seat())]),
        asked("r1", "q1", seat()),
    ];
    assert_eq!(status(&events), Some(Status::Asked));
    assert_eq!(call_result(&events, "q1"), None);
    events.push(k(Known::QuestionAnswered {
        call_id: "q1".into(),
        answers: vec![json!("Exit row")],
        late: false,
        typed: false,
    }));
    assert_eq!(status(&events), Some(Status::Answered));
    assert_eq!(
        call_result(&events, "q1").sure(),
        "The person answered.\n\nWindow or aisle?\nAnswer: Exit row (in their own words)"
    );
    assert!(!crate::Transcript::fold(&events).asking());
}

#[test]
fn a_typed_message_answers_the_waiting_card_and_the_card_shows_its_answer() {
    let mut events = vec![
        Event::user_message("Book me a seat"),
        Event::reply_started("r1", "m"),
        step("r1", &[("q1", seat())]),
        asked("r1", "q1", seat()),
    ];
    let message = Event::user_message("Aisle");
    let answer = typed_answer(&events, &message).sure();
    events.push(message);
    events.push(answer);
    assert_eq!(status(&events), Some(Status::Answered));
    assert_eq!(call_result(&events, "q1").sure(), ANSWERED_BY_MESSAGE);
    let card = &views(&events)[0];
    assert_eq!((card.standing, card.typed), (Standing::Answered, true));
    assert_eq!(card.answers, Some(vec![json!("Aisle")]));

    let mut bot = Event::user_message("Aisle");
    if let Event::Known(Known::UserMessage { from_agent, .. }) = &mut bot {
        *from_agent = Some(crate::event::FromAgent {
            id: "a2".into(),
            name: "Other".into(),
            depth: 1,
            machine: None,
        });
    }
    let fresh = &events[..4];
    assert_eq!(typed_answer(fresh, &bot), None, "another bot never answers");
}

#[test]
fn answer_later_answers_the_call_at_once_and_the_late_answer_reads_as_a_question_answer() {
    let mut events = vec![
        Event::user_message("Plan a trip"),
        Event::reply_started("r1", "m"),
        step("r1", &[("q1", seat())]),
        asked("r1", "q1", seat()),
        k(Known::QuestionDeferred {
            call_id: "q1".into(),
            by_bot: false,
        }),
    ];
    assert_eq!(status(&events), Some(Status::Answered));
    assert_eq!(call_result(&events, "q1").sure(), DEFERRED);
    assert!(!crate::Transcript::fold(&events).waiting_on_you());
    events.push(finished("r1", "q1", DEFERRED));
    events.push(reply_finished("r1"));
    assert_eq!(for_later(&events), 1);
    assert!(!needs_reply(&events));

    let late = k(Known::QuestionAnswered {
        call_id: "q1".into(),
        answers: vec![json!("Window")],
        late: true,
        typed: false,
    });
    events.push(late);
    assert!(
        needs_reply(&events),
        "a late answer opens a reply like a job's result"
    );
    assert_eq!(for_later(&events), 0);
    let shown = crate::context::messages(&events);
    let Some(Message::Person { text, .. }) = shown.last() else {
        panic!("the late answer is read last");
    };
    assert_eq!(
        text,
        "<question_answer call=\"q1\">\nWindow or aisle?\nAnswer: Window\n</question_answer>"
    );
}

#[test]
fn a_late_answer_steering_an_open_reply_is_read_after_the_running_calls_results() {
    let events = vec![
        Event::user_message("Plan a trip"),
        Event::reply_started("r1", "m"),
        step(
            "r1",
            &[("q1", json!({ "question": "Budget?", "wait": false }))],
        ),
        asked("r1", "q1", json!({ "question": "Budget?" })),
        k(Known::QuestionDeferred {
            call_id: "q1".into(),
            by_bot: true,
        }),
        finished("r1", "q1", ASKED_FOR_LATER),
        step("r1", &[("w1", json!({}))]),
        k(Known::QuestionDismissed {
            call_id: "q1".into(),
            late: true,
        }),
        finished("r1", "w1", "searched"),
    ];
    let shown = crate::context::messages(&events);
    let tail: Vec<String> = shown
        .iter()
        .rev()
        .take(2)
        .map(|m| match m {
            Message::Person { text, .. } => format!("person:{text}"),
            Message::ToolResult { call_id, .. } => format!("result:{call_id}"),
            Message::Spade { .. } => "spade".into(),
        })
        .collect();
    assert_eq!(
        tail,
        vec![
            format!("person:<question_answer call=\"q1\">\n{DISMISSED}\n</question_answer>"),
            "result:w1".to_owned()
        ]
    );
    assert_eq!(views(&events)[0].standing, Standing::Dismissed);
    assert!(views(&events)[0].asked_for_later);
}

#[test]
fn a_late_answer_after_a_compaction_cut_still_names_its_prompts() {
    let mut events = vec![
        Event::user_message("Plan"),
        Event::reply_started("r1", "m"),
        step("r1", &[("q1", json!({ "question": "Budget?" }))]),
        asked("r1", "q1", json!({ "question": "Budget?" })),
        k(Known::QuestionDeferred {
            call_id: "q1".into(),
            by_bot: false,
        }),
        finished("r1", "q1", DEFERRED),
        reply_finished("r1"),
        Event::user_message("Next thing"),
    ];
    events.push(k(Known::ContextCompacted {
        summary: "earlier".into(),
        keep_from: 7,
        tokens_before: 0,
        images_left_out: None,
        untrusted: false,
    }));
    events.push(k(Known::QuestionAnswered {
        call_id: "q1".into(),
        answers: vec![json!("About 2,000")],
        late: true,
        typed: false,
    }));
    let first = crate::context::messages(&events);
    let text = match first.last() {
        Some(Message::Person { text, .. }) => text.clone(),
        _ => String::new(),
    };
    assert!(text.contains("Budget?\nAnswer: About 2,000"), "{text}");
    assert_eq!(
        crate::context::messages(&events),
        first,
        "rebuilt to the same messages"
    );
}

#[test]
fn a_dismissed_waiting_question_answers_its_call_once() {
    let events = vec![
        Event::user_message("Book"),
        Event::reply_started("r1", "m"),
        step("r1", &[("q1", seat())]),
        asked("r1", "q1", seat()),
        k(Known::QuestionDismissed {
            call_id: "q1".into(),
            late: false,
        }),
    ];
    assert_eq!(call_result(&events, "q1").sure(), DISMISSED);
    assert_eq!(views(&events)[0].standing, Standing::Dismissed);
    assert_eq!(for_later(&events), 0);
    let mut later = events.clone();
    later.push(finished("r1", "q1", DISMISSED));
    later.push(reply_finished("r1"));
    assert!(
        !needs_reply(&later),
        "a waiting card's dismissal opens no reply of its own"
    );
}

#[test]
fn the_count_for_later_goes_down_as_each_is_answered_or_dismissed_and_a_stop_leaves_it() {
    let mut events = vec![Event::user_message("Plan"), Event::reply_started("r1", "m")];
    for id in ["q1", "q2", "q3"] {
        events.push(asked("r1", id, json!({ "question": id })));
        events.push(k(Known::QuestionDeferred {
            call_id: id.into(),
            by_bot: true,
        }));
    }
    events.push(asked("r1", "q4", json!({ "question": "waits" })));
    assert_eq!(for_later(&events), 3, "the waiting one is not for later");
    events.push(k(Known::StopRequested {
        reply: Some("r1".into()),
        jobs: Vec::new(),
    }));
    events.push(Event::reply_ended(ReplyEnd::Stopped, "r1", ""));
    assert_eq!(for_later(&events), 3, "deferred questions never expire");
    assert_eq!(standing(&events, "q4"), Some(Standing::Closed));
    events.push(k(Known::QuestionAnswered {
        call_id: "q1".into(),
        answers: vec![json!("x")],
        late: true,
        typed: false,
    }));
    assert_eq!(for_later(&events), 2);
    events.push(k(Known::QuestionDismissed {
        call_id: "q2".into(),
        late: true,
    }));
    assert_eq!(for_later(&events), 1);
    let restored: Vec<Event> = events
        .iter()
        .map(|e| Event::from_json(e.to_json()))
        .collect();
    assert_eq!(for_later(&restored), 1, "read back from stored JSON");
}

#[test]
fn a_cli_turn_gets_late_answers_and_a_card_answer_never_swallows_the_next_message() {
    let events = vec![
        Event::user_message("Plan"),
        Event::reply_started("r1", "cli:claude/opus"),
        step("r1", &[("q1", seat())]),
        asked("r1", "q1", seat()),
        k(Known::QuestionDeferred {
            call_id: "q1".into(),
            by_bot: false,
        }),
        finished("r1", "q1", DEFERRED),
        Event::user_message("Also find hotels"),
        k(Known::QuestionAnswered {
            call_id: "q1".into(),
            answers: vec![json!("Aisle")],
            late: true,
            typed: false,
        }),
    ];
    let mut seen = events.clone();
    if let Some(Event::Known(Known::StepFinished { seen: s, .. })) = seen.get_mut(2) {
        *s = Some(3);
    }
    let turn = crate::brain::next_turn(&seen).sure();
    assert!(
        turn.message.contains("Also find hotels"),
        "{}",
        turn.message
    );
    assert!(
        turn.message.contains("<question_answer call=\"q1\">"),
        "{}",
        turn.message
    );
}

#[test]
fn questions_round_trip_through_stored_json_and_old_events_read_as_one_text_question() {
    let event = asked("r1", "q1", seat());
    assert_eq!(Event::from_json(event.to_json()), event);
    assert_eq!(event.to_json()["questions"][0]["kind"], "choice");
    let old = json!({ "type": "question_asked", "reply": "r1", "call_id": "q1", "question": "Which city?" });
    let events = vec![Event::from_json(old)];
    assert_eq!(
        views(&events)[0].questions[0].kind,
        Kind::Text { placeholder: None }
    );
    assert_eq!(views(&events)[0].questions[0].prompt, "Which city?");
}
