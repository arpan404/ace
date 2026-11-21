use serde_json::{Value, json};

use super::*;
use crate::event::{Event, Known};
use crate::question::{Standing, check_answers, typed_answer, views};

fn form(properties: Value) -> Value {
    json!({ "type": "object", "properties": properties })
}

fn shown(app: &str, message: &str, schema: &Value) -> Card {
    match card(app, message, schema) {
        Ok(card) => card,
        Err(why) => panic!("not shown: {why:?}"),
    }
}

#[test]
fn a_form_becomes_a_card_labelled_with_its_app_one_question_per_field() {
    let schema = form(json!({
        "name": { "type": "string", "title": "Name on the card", "description": "As printed" },
        "size": { "type": "string", "oneOf": [
            { "const": "s", "title": "Small" }, { "const": "l", "title": "Large" }
        ] },
        "copies": { "type": "integer", "minimum": 1, "maximum": 9 },
        "rush": { "type": "boolean", "title": "Rush it?" },
        "when": { "type": "string", "format": "date" },
    }));
    let card = shown("Printly", "Details for the print job.", &schema);
    assert_eq!(card.summary, "Printly asks: Details for the print job.");
    let kinds: Vec<(&str, &str)> = card
        .questions
        .iter()
        .map(|q| (q.id.as_deref().unwrap_or(""), q.kind.name()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("name", "text"),
            ("size", "choice"),
            ("copies", "number"),
            ("rush", "confirm"),
            ("when", "date"),
        ]
    );
    // The first prompt says which app asks, and why, before its field.
    assert_eq!(
        card.questions[0].prompt,
        "Printly asks: Details for the print job.\n\nName on the card"
    );
    assert_eq!(card.questions[3].prompt, "Rush it?");
}

#[test]
fn the_answers_on_the_card_go_back_typed_as_the_form_asks() {
    let schema = form(json!({
        "size": { "type": "string", "oneOf": [
            { "const": "s", "title": "Small" }, { "const": "l", "title": "Large" }
        ] },
        "copies": { "type": "integer" },
        "tags": { "type": "array", "items": { "anyOf": [
            { "const": "red", "title": "Red" }, { "const": "blue", "title": "Blue" }
        ] } },
    }));
    let card = shown("Printly", "Pick.", &schema);
    let given = [json!("Large"), json!(3.0), json!(["Blue"])];
    let checked = match check_answers(&card.questions, &given) {
        Ok(checked) => checked,
        Err(why) => panic!("{why}"),
    };
    let Answer::Accept(content) = answer(&schema, &card.questions, &checked) else {
        panic!("declined");
    };
    assert_eq!(
        Value::Object(content),
        json!({ "size": "l", "copies": 3, "tags": ["blue"] })
    );
}

#[test]
fn a_form_with_nothing_to_fill_in_asks_to_go_ahead() {
    let schema = form(json!({}));
    let card = shown("Printly", "Print now?", &schema);
    assert_eq!(card.questions.len(), 1);
    assert_eq!(card.questions[0].kind.name(), "confirm");
    assert_eq!(
        answer(&schema, &card.questions, &[json!(true)]),
        Answer::Accept(Map::new())
    );
    assert_eq!(
        answer(&schema, &card.questions, &[json!(false)]),
        Answer::Decline
    );
}

#[test]
fn a_form_asking_for_a_secret_is_never_shown() {
    let secret = [
        (
            "Sign in.",
            form(json!({ "password": { "type": "string" } })),
        ),
        ("Connect.", form(json!({ "apiKey": { "type": "string" } }))),
        ("Connect.", form(json!({ "api_key": { "type": "string" } }))),
        (
            "Pay.",
            form(json!({ "n": { "type": "string", "title": "Card number" } })),
        ),
        (
            "Pay.",
            form(json!({ "code": { "type": "string", "description": "The CVV on the back" } })),
        ),
        ("Unlock.", form(json!({ "pin": { "type": "string" } }))),
        (
            "Go on.",
            form(json!({ "v": { "type": "string", "format": "password" } })),
        ),
        (
            "Go on.",
            form(json!({ "v": { "type": "string", "writeOnly": true } })),
        ),
        (
            "Paste your access token to go on.",
            form(json!({ "v": { "type": "string" } })),
        ),
    ];
    for (message, schema) in secret {
        assert_eq!(
            card("Fake", message, &schema),
            Err(Refused::Secret),
            "{message} {schema}"
        );
    }
    // Words that only look like one are shown.
    let plain = [
        (
            "Which message should be pinned?",
            form(json!({ "pinned": { "type": "boolean" } })),
        ),
        (
            "Name the project.",
            form(json!({ "name": { "type": "string" } })),
        ),
        (
            "Which spinner?",
            form(json!({ "spinner": { "type": "string" } })),
        ),
    ];
    for (message, schema) in plain {
        assert!(card("Fake", message, &schema).is_ok(), "{message} {schema}");
    }
}

#[test]
fn a_field_a_card_cant_hold_declines_the_form() {
    let nested = form(json!({ "address": { "type": "object" } }));
    assert!(matches!(
        card("Fake", "Where?", &nested),
        Err(Refused::Unreadable(_))
    ));
    let one_option = form(json!({ "only": { "type": "string", "enum": ["a"] } }));
    assert!(matches!(
        card("Fake", "Pick.", &one_option),
        Err(Refused::Unreadable(_))
    ));
}

#[test]
fn a_forms_card_belongs_to_its_call_and_no_other_card_does() {
    let id = card_id("toolu_01", 2);
    assert_eq!(call_of(&id), Some("toolu_01"));
    assert_eq!(call_of("toolu_01"), None);
    assert_eq!(call_of("~form1"), None);
    assert_eq!(call_of("toolu_01~formx"), None);
}

fn asked(call_id: &str, reply: &str) -> Event {
    let card = shown(
        "Fake",
        "Which name?",
        &form(json!({ "name": { "type": "string" } })),
    );
    Event::Known(Known::QuestionAsked {
        reply: reply.to_owned(),
        call_id: call_id.to_owned(),
        question: card.summary,
        questions: card.questions,
        later: false,
    })
}

fn finished(call_id: &str) -> Event {
    Event::Known(Known::ToolFinished {
        reply: "r1".into(),
        call_id: call_id.into(),
        name: "fake__ask_name".into(),
        content: "done".into(),
        is_error: false,
        uncertain: false,
        images: Vec::new(),
        untrusted: false,
    })
}

#[test]
fn a_typed_message_never_answers_an_apps_form() {
    let form_card = card_id("c1", 1);
    let events = [asked(&form_card, "r1"), Event::user_message("Ada")];
    let standing = views(events.iter())
        .into_iter()
        .find(|c| c.call_id == form_card)
        .map(|c| c.standing);
    assert_eq!(standing, Some(Standing::Waiting));
    assert_eq!(typed_answer(&events[..1], &events[1]), None);
    // A bot's own question still is answered by it.
    let events = [asked("c2", "r1"), Event::user_message("Ada")];
    assert!(typed_answer(&events[..1], &events[1]).is_some());
}

#[test]
fn an_apps_form_closes_when_its_call_ends_and_no_one_waits_on_it() {
    let form_card = card_id("c1", 1);
    let started = Event::reply_started("r1", "m");
    let events = vec![started.clone(), asked(&form_card, "r1"), finished("c1")];
    let standing = views(events.iter())
        .into_iter()
        .find(|c| c.call_id == form_card)
        .map(|c| c.standing);
    assert_eq!(standing, Some(Standing::Closed));
    let transcript = crate::transcript::Transcript::fold(&events);
    assert!(!transcript.waiting_on_you());
    // While the call runs, the bot waits on the person.
    let transcript = crate::transcript::Transcript::fold(&events[..2]);
    assert!(transcript.waiting_on_you());
    // Another call ending leaves it open.
    let other = vec![started, asked(&form_card, "r1"), finished("c9")];
    assert!(crate::transcript::Transcript::fold(&other).waiting_on_you());
}
