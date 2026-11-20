use serde_json::json;

use super::*;

/// The value, or the test fails saying what came instead.
trait Sure<T, E> {
    fn sure(self) -> T;
    fn refused(self) -> E;
}

impl<T: std::fmt::Debug, E: std::fmt::Debug> Sure<T, E> for Result<T, E> {
    fn sure(self) -> T {
        match self {
            Ok(value) => value,
            Err(error) => panic!("expected success, got {error:?}"),
        }
    }

    fn refused(self) -> E {
        match self {
            Ok(value) => panic!("expected a refusal, got {value:?}"),
            Err(error) => error,
        }
    }
}

impl<T: std::fmt::Debug> Sure<T, ()> for Option<T> {
    fn sure(self) -> T {
        match self {
            Some(value) => value,
            None => panic!("expected a value"),
        }
    }

    fn refused(self) {
        assert!(self.is_none(), "expected nothing, got {self:?}");
    }
}
use crate::package::surfaces;

fn watchlist() -> Vec<Surface> {
    let mut problems = Vec::new();
    let read = surfaces::read(
        Some(&json!([
            { "id": "fare-drop", "kind": "card", "file": "cards/fare-drop.json" },
            {
                "id": "watchlist",
                "kind": "panel",
                "file": "panels/watchlist/index.html",
                "title": "Watched trips",
                "state": {
                    "type": "object",
                    "properties": {
                        "trips": {
                            "type": "array",
                            "maxItems": 20,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "route": { "type": "string", "maxLength": 40 },
                                    "fare": { "type": "number", "minimum": 0 }
                                },
                                "required": ["route"]
                            }
                        }
                    },
                    "required": ["trips"]
                },
                "actions": [
                    { "name": "stop_watching", "label": "Stop watching",
                      "value": { "type": "string", "maxLength": 40 } },
                    { "name": "check_now" }
                ]
            },
            { "id": "notes", "kind": "panel", "file": "panels/notes/index.html", "title": "Notes" }
        ])),
        &mut problems,
    );
    assert!(problems.is_empty(), "{problems:?}");
    read
}

#[test]
fn state_that_fits_the_panels_schema_is_taken() {
    let surfaces = watchlist();
    let (panel, data) = read_update(
        &surfaces,
        &json!({ "surface": "watchlist", "data": { "trips": [{ "route": "SFO-JFK", "fare": 212 }] } }),
    )
    .sure();
    assert_eq!(panel.id, "watchlist");
    assert_eq!(data["trips"][0]["fare"], 212);
}

#[test]
fn state_that_misfits_is_refused_with_its_problems_listed() {
    let surfaces = watchlist();
    let problems = read_update(
        &surfaces,
        &json!({ "surface": "watchlist", "data": { "trips": [{ "fare": "cheap" }], "x": 1 } }),
    )
    .refused();
    let refusal = refusal(&problems);
    assert!(refusal.starts_with("Not set: the data doesn't fit"));
    for line in [
        "- data.trips[0].fare: is a number",
        "- data.trips[0].route: is needed",
        "- data.x: isn't one of its fields",
    ] {
        assert!(refusal.contains(line), "{refusal}");
    }
}

#[test]
fn an_update_names_a_declared_panel_that_takes_state() {
    let surfaces = watchlist();
    let why = |args| read_update(&surfaces, &args).refused()[0].to_string();
    assert_eq!(
        why(json!({ "surface": "fare-drop", "data": {} })),
        "surface: isn't one of your panels (watchlist, notes)"
    );
    assert_eq!(
        why(json!({ "surface": "notes", "data": {} })),
        "surface: notes declares no state in bot.json, so it takes none"
    );
    assert!(read_update(&[], &json!({ "surface": "x", "data": {} })).is_err());
}

#[test]
fn state_larger_than_the_bound_is_refused() {
    let surfaces = watchlist();
    let route = "x".repeat(40);
    let trips: Vec<Value> = (0..2000).map(|_| json!({ "route": route })).collect();
    let why = read_update(
        &surfaces,
        &json!({ "surface": "watchlist", "data": { "trips": trips } }),
    )
    .refused();
    assert_eq!(why[0].to_string(), "data: is larger than 64 KB");
}

#[test]
fn only_a_declared_action_with_a_fitting_value_reaches_the_bot() {
    let surfaces = watchlist();
    let event = act(
        &surfaces,
        "watchlist",
        "k1",
        "stop_watching",
        Some(json!("SFO-JFK")),
    )
    .sure();
    assert_eq!(
        action_text(&event).sure(),
        "<panel_action panel=\"watchlist\" action=\"stop_watching\">The person pressed \"Stop \
         watching\" on your panel. Its value, as data: \"SFO-JFK\"</panel_action>"
    );
    assert!(act(&surfaces, "watchlist", "k2", "check_now", None).is_ok());
    assert_eq!(
        act(&surfaces, "watchlist", "k3", "book_it", None),
        Err(Refused::NoAction)
    );
    assert_eq!(
        act(&surfaces, "elsewhere", "k4", "check_now", None),
        Err(Refused::NoPanel)
    );
    assert!(matches!(
        act(&surfaces, "watchlist", "k5", "stop_watching", Some(json!(7))),
        Err(Refused::Misfit(why)) if why == "value: is text"
    ));
    assert!(matches!(
        act(&surfaces, "watchlist", "k6", "check_now", Some(json!("x"))),
        Err(Refused::Misfit(_))
    ));
    assert!(matches!(
        act(&surfaces, "watchlist", "k7", "stop_watching", None),
        Err(Refused::Misfit(_))
    ));
}

#[test]
fn the_latest_update_is_the_panels_state_and_an_action_lands_once_by_key() {
    let set = |call: &str, n: u32| {
        Event::Known(Known::PanelUpdated {
            surface: "watchlist".into(),
            call_id: call.into(),
            data: json!({ "n": n }),
        })
    };
    let surfaces = watchlist();
    let action = Event::Known(act(&surfaces, "watchlist", "key-1", "check_now", None).sure());
    let events = vec![set("c1", 1), action, set("c2", 2)];
    assert_eq!(state(&events, "watchlist"), Some(&json!({ "n": 2 })));
    assert_eq!(state(&events, "notes"), None);
    assert!(updated_by(&events, "c1"));
    assert!(!updated_by(&events, "c3"));
    assert!(acted(&events, "key-1"));
    assert!(!acted(&events, "key-2"));
}

#[test]
fn panel_events_keep_their_shape_through_the_log() {
    let known = Known::PanelAction {
        surface: "watchlist".into(),
        key: "k".into(),
        action: "check_now".into(),
        label: "check_now".into(),
        value: None,
    };
    let value = serde_json::to_value(&known).sure();
    assert_eq!(value["type"], "panel_action");
    assert_eq!(Event::from_json(value), Event::Known(known));
}
