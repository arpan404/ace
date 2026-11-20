use serde_json::{Value, json};

use super::*;

/// The value, or the test fails saying what came instead.
trait Sure<T> {
    fn sure(self) -> T;
    fn refused(self) -> Vec<Problem>;
}

impl<T, E: std::fmt::Debug> Sure<T> for Result<T, E>
where
    E: Into<Vec<Problem>>,
{
    fn sure(self) -> T {
        match self {
            Ok(value) => value,
            Err(error) => panic!("expected success, got {error:?}"),
        }
    }

    fn refused(self) -> Vec<Problem> {
        match self {
            Ok(_) => panic!("expected a refusal"),
            Err(error) => error.into(),
        }
    }
}

fn fare_drop() -> Value {
    json!({
        "title": "Fare dropped: KTM to DEL",
        "blocks": [
            { "kind": "metric", "label": "Fare", "value": 182, "unit": "USD", "change": "-24" },
            { "kind": "fields", "rows": [{ "label": "Dates", "value": "12-19 Jan" }] },
            { "kind": "progress", "label": "Trips checked", "value": 3, "max": 5 },
            { "kind": "table", "columns": ["Carrier", "Fare"],
              "rows": [["Buddha Air", "182"], ["Yeti", "199"]] },
            { "kind": "list", "items": ["Morning flight", "One bag"], "ordered": true },
            { "kind": "image", "file": "charts/fares.png", "alt": "Fares this week" },
            { "kind": "link", "url": "https://fares.example.com/ktm-del", "label": "The fare" },
            { "kind": "actions", "actions": [
                { "kind": "choose", "id": "keep", "label": "Keep watching" },
                { "kind": "choose", "id": "stop", "label": "Stop watching" },
                { "kind": "open", "label": "See it", "url": "https://fares.example.com/x" } ] }
        ]
    })
}

fn problems(data: Value) -> Vec<String> {
    match check(&data) {
        Ok(_) => Vec::new(),
        Err(found) => found.iter().map(ToString::to_string).collect(),
    }
}

#[test]
fn every_kind_of_block_that_fits_its_rules_is_kept_in_order() {
    let card = check(&fare_drop()).sure();
    assert_eq!(card.title, "Fare dropped: KTM to DEL");
    let kinds: Vec<Value> = card
        .blocks
        .iter()
        .map(|b| serde_json::to_value(b).unwrap_or_default()["kind"].clone())
        .collect();
    assert_eq!(
        kinds,
        json!([
            "metric", "fields", "progress", "table", "list", "image", "link", "actions"
        ])
        .as_array()
        .cloned()
        .unwrap_or_default()
    );
    // A number given as a value reads as its text; a link keeps its host for the client to show.
    assert!(matches!(&card.blocks[0], Block::Metric { value, .. } if value == "182"));
    assert!(matches!(&card.blocks[6], Block::Link { host, .. } if host == "fares.example.com"));
    assert_eq!(card.files(), vec!["charts/fares.png"]);
    assert_eq!(card.choice("stop"), Some("Stop watching"));
}

#[test]
fn data_that_doesnt_fit_is_refused_with_every_problem_at_its_place() {
    let found = problems(json!({
        "title": "",
        "colour": "red",
        "blocks": [
            { "kind": "fields", "rows": [{ "label": "Route" }] },
            { "kind": "progress", "value": 7, "max": 5 },
            { "kind": "table", "columns": ["A", "B"], "rows": [["only one"]] },
            { "kind": "link", "url": "http://plain.example.com" },
            { "kind": "html", "body": "<script>" },
            { "kind": "actions", "actions": [
                { "kind": "run", "label": "Do it" },
                { "kind": "open", "label": "Go", "url": "javascript:alert(1)" } ] }
        ]
    }));
    assert_eq!(
        found,
        vec![
            "data.colour: not a field here; this takes title, blocks.",
            "data.title: empty.",
            "data.blocks[0].rows[0].value: missing.",
            "data.blocks[1]: value runs from 0 to max, and max is above 0.",
            "data.blocks[2].rows[0]: 2 cells, one per column.",
            "data.blocks[3].url: an https address.",
            "data.blocks[4].kind: html is not a block; use fields, metric, progress, table, list, \
             image, link or actions.",
            "data.blocks[5].actions[0].kind: choose or open.",
            "data.blocks[5].actions[1].url: an https address.",
        ]
    );
}

#[test]
fn a_card_is_bounded_in_blocks_text_and_size() {
    let blocks: Vec<Value> = (0..13)
        .map(|_| json!({ "kind": "list", "items": ["x"] }))
        .collect();
    assert_eq!(
        problems(json!({ "title": "Many", "blocks": blocks })),
        vec!["data.blocks: at most 12 blocks."]
    );
    assert_eq!(
        problems(json!({ "title": "t".repeat(121) })),
        vec!["data.title: at most 120 characters."]
    );
    assert_eq!(
        problems(
            json!({ "title": "Big", "blocks": [{ "kind": "list", "items": ["x".repeat(20_000)] }] })
        ),
        vec!["data: at most 16 KiB of data."]
    );
    let twice = json!({ "title": "Two", "blocks": [
        { "kind": "actions", "actions": [{ "kind": "choose", "id": "a", "label": "A" }] },
        { "kind": "actions", "actions": [{ "kind": "choose", "id": "a", "label": "B" }] } ] });
    assert_eq!(
        problems(twice),
        vec![
            "data.blocks: one actions block at most.",
            "data.blocks: each choice needs its own id."
        ]
    );
}

fn shown_event(call: &str, card: &str, version: u32, data: Value) -> Event {
    Event::Known(Known::CardShown(Box::new(Shown {
        reply: "r1".into(),
        call_id: call.into(),
        card: card.into(),
        version,
        data: check(&data).sure(),
        untrusted: false,
    })))
}

#[test]
fn replacing_a_card_makes_its_next_version_and_an_unknown_one_is_refused() {
    let events = vec![shown_event("c1", "card_1", 1, fare_drop())];
    let show = read(
        &events,
        &json!({ "data": { "title": "Fare now 170" }, "replaces": "card_1" }),
    )
    .sure();
    let next = shown(&events, "r2", "c2", "card_2", show, true);
    assert_eq!(
        (next.card.as_str(), next.version, next.untrusted),
        ("card_1", 2, true)
    );

    let fresh = read(&events, &json!({ "data": { "title": "Another trip" } })).sure();
    assert_eq!(
        shown(&events, "r2", "c3", "card_3", fresh, false).card,
        "card_3"
    );

    let refused = read(
        &events,
        &json!({ "data": { "title": "x" }, "replaces": "card_9" }),
    )
    .refused();
    assert_eq!(refused[0].at, "replaces");
    // A card a package ships comes with packages; until then the data carries the card.
    let surface = read(
        &events,
        &json!({ "surface": "fare-drop", "data": { "title": "x" } }),
    )
    .refused();
    assert_eq!(surface[0].at, "surface");
    assert!(refusal(&surface).starts_with("Not shown: the card doesn't fit."));
}

#[test]
fn a_choice_comes_back_once_and_only_on_the_version_the_person_saw() {
    let mut events = vec![shown_event("c1", "card_1", 1, fare_drop())];
    let Ok(chose) = choose(&events, "card_1", 1, "keep") else {
        panic!("the choice is open");
    };
    assert_eq!(
        chose,
        Known::CardAction {
            card: "card_1".into(),
            version: 1,
            action: "keep".into(),
            label: "Keep watching".into(),
        }
    );
    assert_eq!(
        action_text(&events, &chose).as_deref(),
        Some(
            "<card_action card=\"card_1\" action=\"keep\">The person chose \"Keep watching\" on \
             your card \"Fare dropped: KTM to DEL\".</card_action>"
        )
    );
    events.push(Event::Known(chose));
    assert_eq!(choose(&events, "card_1", 1, "stop"), Err(Refused::Chosen));
    assert_eq!(choose(&events, "card_1", 1, "nope"), Err(Refused::Chosen));
    assert_eq!(choose(&events, "card_7", 1, "keep"), Err(Refused::NoCard));

    // A new version opens its choices again; a press on the old one is refused.
    events.push(shown_event("c2", "card_1", 2, fare_drop()));
    assert_eq!(choose(&events, "card_1", 1, "keep"), Err(Refused::Changed));
    assert_eq!(choose(&events, "card_1", 2, "nope"), Err(Refused::NoAction));
    assert!(choose(&events, "card_1", 2, "stop").is_ok());
    assert_eq!(latest(&events, "card_1").map(|v| v.version), Some(2));
}

#[test]
fn a_stored_card_reads_back_as_the_same_event() {
    let event = shown_event("c1", "card_1", 1, fare_drop());
    let json = event.to_json();
    assert_eq!(json["type"], "card_shown");
    assert_eq!(
        json["data"]["blocks"][7]["actions"][2]["host"],
        "fares.example.com"
    );
    assert_eq!(Event::from_json(json), event);
    assert_eq!(
        shown_by(std::slice::from_ref(&event), "c1").map(|s| s.version),
        Some(1)
    );
}
