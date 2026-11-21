use serde_json::{Value, json};

use super::*;
use crate::package::manifest::Build;

const BUILD: Build<'static> = Build {
    version: "0.0.25",
    task_chars: 4_000,
};

fn manifest(checks: Value) -> crate::package::Manifest {
    let suite = crate::spec::conformance::MANIFESTS[4].json();
    let mut bot = suite["base"].clone();
    bot["checks"] = checks;
    crate::package::read(&bot, BUILD).unwrap_or_else(|p| panic!("{p:?}"))
}

#[test]
fn a_schema_check_names_each_miss_by_its_check_and_holds_only_on_its_places() {
    let read = manifest(json!([
        { "name": "fare-has-link", "on": ["contract:cheapest_fare"], "kind": "schema",
          "rule": { "required": ["link"], "properties": { "link": { "pattern": "^https://" } } } },
        { "name": "cheap-enough", "on": ["contract:cheapest_fare", "card:fare-drop"], "kind": "schema",
          "rule": { "properties": { "fare": { "maximum": 500 } } } }
    ]));
    let contract = Target::Contract("cheapest_fare".to_owned());
    assert_eq!(
        misses(&read.checks, &contract, &json!({ "fare": 900 }), "output"),
        vec![
            "fare-has-link: output.link: is missing".to_owned(),
            "cheap-enough: output.fare: is at most 500".to_owned(),
        ]
    );
    assert_eq!(
        misses(
            &read.checks,
            &contract,
            &json!({ "fare": 182, "link": "https://fares.example" }),
            "output"
        ),
        Vec::<String>::new()
    );
    let card = Target::Card("fare-drop".to_owned());
    assert_eq!(
        misses(&read.checks, &card, &json!({ "fare": 900 }), "data"),
        vec!["cheap-enough: data.fare: is at most 500".to_owned()]
    );
    assert_eq!(
        misses(
            &read.checks,
            &Target::Card("other".to_owned()),
            &json!({}),
            "data"
        ),
        Vec::<String>::new()
    );
}

#[test]
fn criterion_checks_are_the_packages_criteria_for_a_goal() {
    let read = manifest(json!([
        { "name": "said-why", "on": ["goal"], "kind": "criterion", "text": " Names the route. " },
        { "name": "fare-has-link", "on": ["contract:cheapest_fare"], "kind": "schema",
          "rule": { "required": ["link"] } }
    ]));
    assert_eq!(criteria(&read.checks), vec!["Names the route.".to_owned()]);
}

#[test]
fn a_verified_trigger_is_known_by_its_name() {
    let suite = crate::spec::conformance::MANIFESTS[4].json();
    let mut bot = suite["base"].clone();
    bot["triggers"][1]["verify"] = json!(true);
    let read = crate::package::read(&bot, BUILD).unwrap_or_else(|p| panic!("{p:?}"));
    assert!(read.verifies("Morning fares"));
    assert!(!read.verifies("Evening fares"));
}
