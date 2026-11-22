use serde_json::Value;

use super::*;
use crate::event::{Event, FromGroup, GroupBot, Known};

const CASES: &str = include_str!("../../../../docs/chat-markup.cases.json");

fn expected(segment: &Value) -> Segment {
    let text = |key: &str| segment[key].as_str().map(str::to_owned);
    Segment {
        kind: match segment["kind"].as_str() {
            Some("doc") => Kind::Doc,
            _ => Kind::Msg,
        },
        text: text("text").unwrap_or_default(),
        reply: text("reply"),
        title: text("title"),
        open: segment["open"].as_bool().unwrap_or(false),
    }
}

#[test]
fn every_case_of_the_shared_table_splits_as_it_says() {
    let table: Value =
        serde_json::from_str(CASES).unwrap_or_else(|e| panic!("the case table is JSON: {e}"));
    let cases = table["cases"]
        .as_array()
        .unwrap_or_else(|| panic!("the table lists cases"));
    assert!(cases.len() > 30);
    let mut wrong = Vec::new();
    for case in cases {
        let text = case["text"].as_str().unwrap_or_default();
        let live = case["live"].as_bool().unwrap_or(false);
        let got = if live { parse_live(text) } else { parse(text) };
        let want: Vec<Segment> = case["segments"]
            .as_array()
            .map(|s| s.iter().map(expected).collect())
            .unwrap_or_default();
        if got != want {
            wrong.push(format!(
                "{}:\n  got  {got:?}\n  want {want:?}",
                case["name"]
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn ids_name_the_first_message_by_seq_and_later_ones_by_place() {
    assert_eq!(id(30, 0), "m30");
    assert_eq!(id(30, 1), "m30.2");
    assert_eq!(id(30, 2), "m30.3");
    assert!(is_id("m7") && is_id("m12.3"));
    assert!(!is_id("m") && !is_id("m0") && !is_id("m7.1") && !is_id("7") && !is_id("m7."));
}

#[test]
fn plain_text_drops_the_markup_and_keeps_a_documents_title() {
    let text = "<msg>Found two.</msg><msg reply=\"m3\">Tuesday.</msg>\
                <doc title=\"Plan\">Day 1</doc>";
    assert_eq!(plain(text), "Found two.\n\nTuesday.\n\nPlan\n\nDay 1");
    assert_eq!(plain("Just words. "), "Just words.");
    assert_eq!(plain(""), "");
}

#[test]
fn the_bots_past_words_read_back_with_their_ids_one_per_line() {
    let text = "<msg>Found two.</msg>\n<msg reply=m7>Tuesday works.</msg>\n\
                <doc title=\"Lisbon plan\">Day 1</doc>";
    assert_eq!(
        for_model(text, 30),
        "<msg id=\"m30\">Found two.</msg>\n<msg id=\"m30.2\" reply=\"m7\">Tuesday works.</msg>\n\
         <doc id=\"m30.3\" title=\"Lisbon plan\">Day 1</doc>"
    );
    assert_eq!(
        for_model("An old plain reply.", 4),
        "<msg id=\"m4\">An old plain reply.</msg>"
    );
    assert_eq!(for_model("", 4), "");
    assert_eq!(for_model(" \n", 4), "");
}

fn step(text: &str) -> Event {
    Event::Known(Known::StepFinished {
        reply: "r1".into(),
        text: text.into(),
        calls: Vec::new(),
        thoughts: Vec::new(),
        usage: Default::default(),
        cost_micros: 0,
        seen: None,
    })
}

fn relayed(text: &str) -> Event {
    let Event::Known(Known::UserMessage {
        text,
        context,
        images,
        documents,
        voice,
        from_agent,
        from_routine,
        from_thread,
        reply_to,
        ..
    }) = Event::user_message(text)
    else {
        unreachable!("user_message makes a user message")
    };
    Event::Known(Known::UserMessage {
        text,
        context,
        images,
        documents,
        voice,
        from_agent,
        from_routine,
        from_group: Some(Box::new(FromGroup {
            id: "g1".into(),
            name: "Trips".into(),
            run: "run1".into(),
            ask: "a1".into(),
            machine: None,
            untrusted: false,
        })),
        from_thread,
        reply_to,
    })
}

fn club(text: &str, from: Option<&str>) -> Event {
    Event::Known(Known::GroupMessage {
        run: "run1".into(),
        text: text.into(),
        from: from.map(|name| GroupBot {
            id: "b1".into(),
            name: name.into(),
            machine: None,
        }),
        thread: None,
        reply_to: None,
    })
}

#[test]
fn a_quote_finds_the_persons_message_or_the_bots_nth_message_by_id() {
    let events = vec![
        Event::user_message("Find me flights to Lisbon"),
        step("<msg>Found 3.</msg><msg>Cheapest is 9:10.</msg>"),
        relayed("From the club"),
        Event::reply_ended(crate::event::ReplyEnd::Stopped, "r1", "Half a"),
    ];
    let mine = quoted(&events, "m1").unwrap_or_else(|| panic!("the person's message"));
    assert_eq!(
        (mine.text.as_str(), mine.mine, mine.name),
        ("Find me flights to Lisbon", true, None)
    );
    let second = quoted(&events, "m2.2").unwrap_or_else(|| panic!("the step's second message"));
    assert_eq!(
        (second.text.as_str(), second.mine),
        ("Cheapest is 9:10.", false)
    );
    assert_eq!(second.id, "m2.2");
    assert_eq!(quoted(&events, "m4").map(|q| q.text), Some("Half a".into()));
    // A message relayed through a club, a missing segment, an id past the end, or no id at all.
    for missing in ["m3", "m2.3", "m1.2", "m9", "m0", "two"] {
        assert_eq!(quoted(&events, missing), None, "{missing}");
    }
}

#[test]
fn a_club_quote_names_the_bot_that_wrote_it_or_the_person() {
    let events = vec![
        club("Plan the trip", None),
        club("<msg>On it.</msg><msg>Tuesday?</msg>", Some("Quill")),
    ];
    let person = quoted(&events, "m1").unwrap_or_else(|| panic!("the person's club message"));
    assert!(person.mine);
    let quill = quoted(&events, "m2.2").unwrap_or_else(|| panic!("Quill's second message"));
    assert_eq!(
        (quill.text.as_str(), quill.mine, quill.name.as_deref()),
        ("Tuesday?", false, Some("Quill"))
    );
}

#[test]
fn a_long_quote_is_cut_to_280_characters_ending_in_an_ellipsis() {
    let events = vec![Event::user_message("é".repeat(400))];
    let quote = quoted(&events, "m1").unwrap_or_else(|| panic!("the message"));
    assert_eq!(quote.text.chars().count(), QUOTE_CHARS);
    assert!(quote.text.ends_with('…'));
    let short = vec![Event::user_message("é".repeat(280))];
    assert!(
        !quoted(&short, "m1")
            .unwrap_or_else(|| panic!("the message"))
            .text
            .ends_with('…')
    );
}

/// A message another bot sent into the conversation, as `bot_message` stores it.
fn from_bot(text: &str, name: &str) -> Event {
    let Event::Known(Known::UserMessage {
        text,
        context,
        images,
        documents,
        voice,
        from_routine,
        from_group,
        from_thread,
        reply_to,
        ..
    }) = Event::user_message(text)
    else {
        unreachable!("user_message makes a user message")
    };
    Event::Known(Known::UserMessage {
        text,
        context,
        images,
        documents,
        voice,
        from_agent: Some(crate::event::FromAgent {
            id: "quill".into(),
            name: name.into(),
            depth: 1,
            machine: None,
            contract: None,
        }),
        from_routine,
        from_group,
        from_thread,
        reply_to,
    })
}

#[test]
fn a_quote_of_another_bots_message_names_that_bot() {
    let events = vec![from_bot(
        "<msg>Fares are up.</msg><msg>TAP is €212.</msg>",
        "Quill",
    )];
    let second = quoted(&events, "m1.2").unwrap_or_else(|| panic!("Quill's second message"));
    assert_eq!(
        (second.text.as_str(), second.mine, second.name.as_deref()),
        ("TAP is €212.", false, Some("Quill"))
    );
}
