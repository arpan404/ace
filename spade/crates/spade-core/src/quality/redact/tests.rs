use serde_json::json;

use super::*;
use crate::quality::case::{self, Keep, Mark};
use crate::{Event, event::Known};

const SECRETS: [&str; 6] = [
    "sk-live-4f9a8b7c6d5e4f3a2b1c",
    "ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z",
    "hunter2-very-private",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "AKIAIOSFODNN7EXAMPLE",
    "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNbVcXz",
];

fn conversation() -> Vec<Event> {
    let call = |id: &str, arguments| crate::event::Call {
        id: id.into(),
        name: "http_get".into(),
        arguments,
    };
    vec![
        Event::user_message(format!(
            "Use my key {} and mail dana.reyes@example.org about it. Password: {}",
            SECRETS[0], SECRETS[2]
        )),
        Event::reply_started("r_1", "e/m"),
        Event::Known(Known::StepFinished {
            reply: "r_1".into(),
            text: format!("Calling with Authorization: Bearer {}", SECRETS[3]),
            calls: vec![call(
                "c_1",
                json!({
                    "url": format!("https://api.example.com/v1?api_key={}", SECRETS[4]),
                    "headers": { "X-Api-Key": SECRETS[5] },
                    "to": "Dana Reyes <dana.reyes@example.org>",
                }),
            )],
            thoughts: Vec::new(),
            usage: crate::event::Tokens::default(),
            cost_micros: 0,
            seen: None,
        }),
        Event::Known(Known::ToolFinished {
            reply: "r_1".into(),
            call_id: "c_1".into(),
            name: "http_get".into(),
            content: format!(
                "{{\"token\": \"{}\", \"owner\": \"Dana\", \"order\": \"ORD-55821\"}}",
                SECRETS[1]
            ),
            is_error: false,
            uncertain: false,
            images: Vec::new(),
            untrusted: false,
        }),
        Event::Known(Known::ReplyFinished {
            reply: "r_1".into(),
            text: "Done, Dana. Order ORD-55821 is on its way to dana.reyes@example.org.".into(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        }),
    ]
}

fn kept(marked: &[String]) -> case::Case {
    let run = case::run(&conversation(), "r_1").unwrap_or_else(|e| panic!("{e}"));
    let made = case::case(
        run,
        Keep {
            id: "case_1".into(),
            bot: "a_1".into(),
            package: None,
            mark: Some(Mark::Right),
            why: Some("Dana liked it".into()),
            made_at: 1,
        },
    );
    let person = Person::from_facts([
        "My name is Dana Reyes.",
        "Signs in as dana.reyes@example.org",
    ]);
    super::case(&made, &person, marked)
}

#[test]
fn a_kept_case_holds_no_secret_address_or_name_the_run_held() {
    let text = serde_json::to_string(&kept(&[])).unwrap_or_default();
    for secret in SECRETS {
        assert!(!text.contains(secret), "{secret} survived: {text}");
    }
    assert!(!text.contains("dana.reyes@example.org"), "{text}");
    assert!(!text.contains("Dana"), "{text}");
    assert!(!text.contains("Reyes"), "{text}");
    assert!(text.contains(ADDRESS) && text.contains(NAME));
}

#[test]
fn what_is_not_secret_stays_so_a_replay_still_has_its_answers() {
    let case = kept(&[]);
    assert_eq!(case.tool_results.len(), 1);
    assert!(case.tool_results[0].content.contains("ORD-55821"));
    assert_eq!(
        case.tool_results[0].arguments["to"],
        json!("Person <person@example.com>")
    );
    assert_eq!(case.why.as_deref(), Some("Person liked it"));
}

#[test]
fn a_value_the_person_marks_on_the_review_is_hidden_everywhere() {
    let text =
        serde_json::to_string(&kept(&[" ORD-55821 ".into(), "x".into()])).unwrap_or_default();
    assert!(!text.contains("ORD-55821"), "{text}");
    // One letter marks nothing: it would hide every word holding it.
    assert!(text.contains("example"));
}

#[test]
fn names_come_only_from_a_naming_phrase_and_whole_words() {
    let person = Person::from_facts(["Prefers aisle seats", "Goes by Dee", "renamed Files"]);
    assert_eq!(person.names, vec!["Dee".to_owned()]);
    assert_eq!(
        replace_word("Deep Dee, dee.", "Dee", NAME),
        "Deep Person, Person."
    );
}
