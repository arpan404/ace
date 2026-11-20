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

fn trips() -> Value {
    json!({
        "type": "object",
        "properties": {
            "trips": {
                "type": "array",
                "maxItems": 20,
                "items": {
                    "type": "object",
                    "properties": {
                        "route": { "type": "string", "maxLength": 40 },
                        "fare": { "type": "number", "minimum": 0 },
                        "cabin": { "enum": ["economy", "business"] },
                        "booked": { "type": "boolean" }
                    },
                    "required": ["route"]
                }
            }
        },
        "required": ["trips"]
    })
}

fn whys(problems: &[Problem]) -> Vec<String> {
    problems.iter().map(ToString::to_string).collect()
}

#[test]
fn data_that_fits_its_schema_has_no_problems() {
    let schema = read(&trips(), "state").sure();
    let data = json!({ "trips": [
        { "route": "SFO-JFK", "fare": 212.5, "cabin": "economy", "booked": false },
        { "route": "LHR-CDG" }
    ]});
    assert!(check(&schema, &data, "data").is_empty());
}

#[test]
fn data_that_misfits_lists_every_problem_at_its_place() {
    let schema = read(&trips(), "state").sure();
    let data = json!({ "trips": [
        { "route": "x".repeat(41), "fare": -1, "cabin": "first", "booked": "yes", "seat": "1A" },
        { "fare": 3 }
    ], "extra": true });
    assert_eq!(
        whys(&check(&schema, &data, "data")),
        [
            "data.trips[0].route: is at most 40 characters",
            "data.trips[0].fare: is at least 0",
            "data.trips[0].cabin: is one of economy, business",
            "data.trips[0].booked: is true or false",
            "data.trips[0].seat: isn't one of its fields",
            "data.trips[1].route: is needed",
            "data.extra: isn't one of its fields",
        ]
    );
}

#[test]
fn a_list_longer_than_its_bound_is_refused() {
    let schema = read(
        &json!({ "type": "array", "maxItems": 2, "items": { "type": "integer" } }),
        "v",
    )
    .sure();
    assert_eq!(
        whys(&check(&schema, &json!([1, 2, 3]), "value")),
        ["value: has at most 2 items"]
    );
    assert_eq!(
        whys(&check(&schema, &json!([1.5]), "value")),
        ["value[0]: is a whole number"]
    );
}

#[test]
fn a_long_list_of_problems_is_summed_up() {
    let schema = read(
        &json!({ "type": "array", "maxItems": 100, "items": { "type": "boolean" } }),
        "v",
    )
    .sure();
    let problems = check(&schema, &json!(vec![0; 30]), "value");
    assert_eq!(problems.len(), 21);
    assert_eq!(problems[20].to_string(), "and 10 more");
}

#[test]
fn a_declaration_without_bounds_is_refused() {
    for (schema, says) in [
        (json!({ "type": "string" }), "maxLength bounds the text"),
        (
            json!({ "type": "array", "items": { "type": "boolean" } }),
            "maxItems bounds the list",
        ),
        (
            json!({ "type": "object" }),
            "properties names the object's fields",
        ),
        (json!({ "type": "date" }), "type is object, array"),
        (json!("string"), "is a schema"),
    ] {
        let problems = read(&schema, "state").refused();
        assert!(
            problems.iter().any(|p| p.contains(says)),
            "{schema}: {problems:?}"
        );
    }
}

#[test]
fn a_keyword_this_build_does_not_enforce_is_refused_not_skipped() {
    let problems = read(
        &json!({ "type": "string", "maxLength": 9, "pattern": "^[A-Z]+$" }),
        "state",
    )
    .refused();
    assert_eq!(
        problems,
        ["state: pattern isn't a keyword this Spade reads for string"]
    );
    let problems = read(
        &json!({ "type": "object", "properties": {}, "additionalProperties": true }),
        "state",
    )
    .refused();
    assert!(problems[0].contains("additionalProperties"));
}

#[test]
fn nesting_deeper_than_six_levels_is_refused() {
    let mut schema = json!({ "type": "boolean" });
    for _ in 0..6 {
        schema = json!({ "type": "object", "properties": { "inner": schema } });
    }
    let problems = read(&schema, "state").refused();
    assert!(problems.iter().any(|p| p.contains("more than 6 levels")));
}

#[test]
fn required_names_only_its_own_properties() {
    let problems = read(
        &json!({ "type": "object", "properties": { "a": { "type": "boolean" } }, "required": ["b"] }),
        "state",
    )
    .refused();
    assert_eq!(problems, ["state.required names its own properties"]);
}
