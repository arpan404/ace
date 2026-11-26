//! ADR 0212 in the prompt: message ids, replies and the bot's words read back with their markup.

use spade_models::Message;

use super::*;
use crate::event::{Event, FromGroup, Known, ReplyEnd, ReplyTo, Tokens};

fn step(text: &str) -> Event {
    Event::Known(Known::StepFinished {
        reply: "r1".into(),
        text: text.into(),
        calls: Vec::new(),
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: None,
    })
}

fn replying(event: Event, to: ReplyTo, group: Option<FromGroup>) -> Event {
    let Event::Known(Known::UserMessage {
        text,
        context,
        images,
        documents,
        voice,
        from_agent,
        from_routine,
        from_thread,
        ..
    }) = event
    else {
        unreachable!("only messages reply")
    };
    Event::Known(Known::UserMessage {
        text,
        context,
        images,
        documents,
        voice,
        from_agent,
        from_routine,
        from_group: group.map(Box::new),
        from_thread,
        reply_to: Some(Box::new(to)),
        invoke: None,
    })
}

fn quote(id: &str, text: &str, mine: bool, name: Option<&str>) -> ReplyTo {
    ReplyTo {
        id: id.into(),
        text: text.into(),
        mine,
        name: name.map(str::to_owned),
    }
}

fn texts(events: &[Event]) -> Vec<String> {
    messages(events)
        .into_iter()
        .map(|message| match message {
            Message::Person { text, .. } | Message::Spade { text, .. } => text,
            Message::ToolResult { content, .. } => content,
        })
        .collect()
}

#[test]
fn the_persons_reply_reads_with_its_id_and_the_words_it_quotes() {
    let events = [
        Event::user_message("Flights to Lisbon?"),
        step("<msg>Found 3.</msg>\n<msg>Cheapest is 9:10.</msg>"),
        replying(
            Event::user_message("Book that one"),
            quote("m2.2", "Cheapest is 9:10.", false, None),
            None,
        ),
        replying(
            Event::user_message("And this too"),
            quote("m1", "Flights to Lisbon?", true, None),
            None,
        ),
    ];
    assert_eq!(
        texts(&events),
        vec![
            "[m1] Flights to Lisbon?".to_owned(),
            "<msg id=\"m2\">Found 3.</msg>\n<msg id=\"m2.2\">Cheapest is 9:10.</msg>".to_owned(),
            "[m3] (replying to your message m2.2: \"Cheapest is 9:10.\")\nBook that one\n\n\
             [m4] (replying to their own message m1: \"Flights to Lisbon?\")\nAnd this too"
                .to_owned(),
        ]
    );
}

#[test]
fn the_persons_reply_to_another_bots_message_names_that_bot() {
    let events = [replying(
        Event::user_message("Skip that one"),
        quote("m1.2", "TAP is €212.", false, Some("Quill")),
        None,
    )];
    assert_eq!(
        texts(&events),
        vec!["[m1] (replying to Quill's message m1.2: \"TAP is €212.\")\nSkip that one".to_owned()]
    );
}

fn trips() -> FromGroup {
    FromGroup {
        id: "g1".into(),
        name: "Trips".into(),
        run: "run1".into(),
        ask: "a1".into(),
        machine: None,
        untrusted: false,
    }
}

#[test]
fn a_club_message_reads_the_quote_by_whose_it_was_with_no_id() {
    let events = [
        replying(
            Event::user_message("Which day?"),
            quote("m4", "Tuesday or Wednesday", false, Some("Quill")),
            Some(trips()),
        ),
        replying(
            Event::user_message("Still that"),
            quote("m2", "Plan the trip", true, None),
            Some(trips()),
        ),
    ];
    let text = texts(&events).join("\n");
    assert!(
        text.contains("(replying to Quill's message: \"Tuesday or Wednesday\")\nWhich day?"),
        "{text}"
    );
    assert!(
        text.contains("(replying to the person's own message: \"Plan the trip\")\nStill that"),
        "{text}"
    );
    assert!(!text.contains("[m1]") && !text.contains("m4"), "{text}");
}

#[test]
fn a_relayed_message_carries_no_id() {
    let mut routine = Event::user_message("Check the mail");
    if let Event::Known(Known::UserMessage { from_routine, .. }) = &mut routine {
        *from_routine = serde_json::from_value(serde_json::json!({
            "id": "rt1", "name": "Mail", "run": "run1", "label": "9:00"
        }))
        .ok();
        assert!(from_routine.is_some());
    }
    let text = texts(&[routine]).join("\n");
    assert!(!text.contains("[m1]"), "{text}");
}

#[test]
fn a_stop_that_repeats_the_last_steps_words_is_read_once_and_new_words_get_their_own_id() {
    let same = [
        Event::user_message("Tell me"),
        Event::reply_started("r1", "m"),
        step("<msg>Half</msg>"),
        Event::reply_ended(ReplyEnd::Stopped, "r1", "<msg>Half</msg>"),
    ];
    assert_eq!(
        texts(&same),
        vec!["[m1] Tell me", "<msg id=\"m3\">Half</msg>"]
    );
    let more = [
        Event::user_message("Tell me"),
        Event::reply_started("r1", "m"),
        step("Half"),
        Event::reply_ended(ReplyEnd::Stopped, "r1", "Half and more"),
    ];
    assert_eq!(
        texts(&more),
        vec![
            "[m1] Tell me",
            "<msg id=\"m3\">Half</msg>",
            "<msg id=\"m4\">Half and more</msg>"
        ]
    );
}

fn teaches_short_messages(system: &str) {
    for needed in [
        "<msg>",
        "one question at a time",
        "<msg reply=\"m7\">",
        "<doc title=\"Lisbon trip plan\">",
        "[m12]",
        "unsure",
    ] {
        assert!(system.contains(needed), "missing {needed:?} in:\n{system}");
    }
}

#[test]
fn every_bots_standing_instructions_teach_it_to_text_in_short_messages() {
    teaches_short_messages(&instructions(SYSTEM, &[]));
    let made = [Event::Known(Known::AgentConfigured {
        task: "Watch flight prices to Lisbon".into(),
        model: "fake/m".into(),
        personality: Some(crate::personality::Personality {
            tone: None,
            humour: true,
            emoji: false,
        }),
        change: None,
    })];
    let made_bot = instructions(SYSTEM, &made);
    teaches_short_messages(&made_bot);
    assert!(made_bot.contains("Watch flight prices to Lisbon"));
}
