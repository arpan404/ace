use serde_json::json;

use super::*;
use crate::effect::Effect;

#[test]
fn a_component_lists_its_tools_and_bad_entries_are_left_out_with_why() {
    let listed = json!([
        { "name": "cheapest", "summary": "Picks the cheapest fare.", "input_schema": { "type": "object", "properties": { "fares": {} } } },
        { "name": "Bad-Name" },
        { "summary": "no name" },
        { "name": "cheapest" },
        { "name": "plain", "extra": true }
    ]);
    let (tools, left_out) = tools_from(&listed.to_string()).unwrap_or_else(|e| panic!("{e}"));
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["cheapest", "plain"]);
    assert_eq!(left_out.len(), 3);
    // A tool with no schema takes any object.
    assert_eq!(tools[1].input_schema, json!({ "type": "object" }));
    assert!(tools_from("{}").is_err());
    assert!(tools_from("not json").is_err());
}

#[test]
fn code_reaches_only_https_hosts_the_package_declares() {
    let hosts = vec![
        "api.example-fares.com".to_owned(),
        "*.cdn.example.com".to_owned(),
    ];
    assert_eq!(
        http_host("https://API.example-fares.com:443/v1?x=1", &hosts),
        Ok("api.example-fares.com".to_owned())
    );
    assert_eq!(
        http_host("https://img.cdn.example.com/a.png", &hosts),
        Ok("img.cdn.example.com".to_owned())
    );
    assert!(http_host("http://api.example-fares.com/", &hosts).is_err());
    assert!(http_host("https://evil.com/", &hosts).is_err());
    assert!(http_host("https://api.example-fares.com.evil.com/", &hosts).is_err());
    assert!(http_host("https://user:pw@api.example-fares.com/", &hosts).is_err());
    assert!(http_host("https://cdn.example.com/", &hosts).is_err());
    let none = http_host("https://api.example-fares.com/", &[]);
    assert!(none.is_err_and(|why| why.contains("declares no network hosts")));
}

#[test]
fn the_hosts_code_reaches_are_those_whose_switch_is_on() {
    let effects = vec![
        Declared {
            effect: Effect::Network,
            hosts: vec!["a.example.com".to_owned()],
            grant: None,
            why: "a".to_owned(),
        },
        Declared {
            effect: Effect::Network,
            hosts: vec!["b.example.com".to_owned()],
            grant: None,
            why: "b".to_owned(),
        },
    ];
    let on = |key: &str| key == "network:hosts:a.example.com";
    assert_eq!(reachable_hosts(&effects, &on), vec!["a.example.com"]);
}

#[test]
fn code_calls_only_spades_own_tools_and_none_the_turn_answers_itself() {
    assert_eq!(call_refusal("memory_search"), None);
    assert_eq!(call_refusal("send_message"), None);
    assert_eq!(call_refusal("workspace_read"), None);
    for barred in [
        "ask_user",
        "shell",
        "call_tool",
        "tool_search",
        "bot_create",
        "task_update",
    ] {
        assert!(call_refusal(barred).is_some(), "{barred}");
    }
    // Not Spade's own: an app's tool, ace's, another component's.
    assert!(call_refusal("gmail_send").is_some());
    assert!(call_refusal("delegate").is_some());
    assert!(call_refusal("browser_click").is_some());
    assert!(call_refusal("code_fares_cheapest").is_some());
}

#[test]
fn a_call_that_gave_no_answer_reads_as_one_line_naming_its_bound() {
    let code = Code {
        name: "fares".to_owned(),
        file: "code/fares.wasm".to_owned(),
        world: crate::package::code::WORLD.to_owned(),
        imports: Vec::new(),
        why: "w".to_owned(),
        timeout_s: 30,
        memory_mb: 128,
    };
    assert_eq!(
        stopped_line(&code, Stop::Deadline),
        "fares stopped: it ran longer than 30 s."
    );
    assert!(stopped_line(&code, Stop::Stopped).contains("not done"));
}

#[test]
fn switch_keys_and_tool_names_read_back() {
    assert_eq!(switch_component(&switch_key("fares")), Some("fares"));
    assert_eq!(switch_component("network:hosts:a.com"), None);
    assert!(is_tool(&tool_name("fares", "cheapest")));
    assert_eq!(tool_name("fares", "cheapest"), "code_fares_cheapest");
}

mod routes {
    use crate::autonomy::Mode;
    use crate::effect::ceiling::{Ceiling, Effects};
    use crate::effect::{Effect, Granted, Route};
    use crate::package::code::run::{CodeCall, route};
    use crate::tools::Risk;

    fn call(tool: &'static str, risk: Risk, effect: Effect) -> CodeCall<'static> {
        CodeCall {
            tool,
            risk,
            effect: Some(effect),
            tainted: false,
            mode: Mode::AutoReview,
            ceiling: None,
            granted: Granted::No,
            checkpointed: false,
            credentials: false,
            target: None,
            org: None,
        }
    }

    fn ceiling(allows: &[Effect]) -> Option<Ceiling<'static>> {
        Some(Ceiling {
            bot: "Fares",
            allows: allows.iter().copied().collect::<Effects>(),
        })
    }

    fn asks(route: &Route) -> bool {
        matches!(route, Route::Ask { .. })
    }

    #[test]
    fn a_read_runs_and_a_send_from_code_goes_to_the_person_in_every_mode() {
        assert_eq!(
            route(call("memory_search", Risk::Read, Effect::Read)),
            Route::Run
        );
        for mode in [Mode::AutoReview, Mode::FullAccess] {
            let send = CodeCall {
                mode,
                ceiling: ceiling(&[Effect::SendAsPerson]),
                // Even a grant of the person's doesn't carry to code under a ceiling.
                granted: Granted::Typed,
                ..call("send_message", Risk::Write, Effect::SendAsPerson)
            };
            assert!(asks(&route(send)), "{mode:?}");
        }
    }

    #[test]
    fn the_ceiling_holds_code_in_full_access() {
        for mode in [Mode::AutoReview, Mode::FullAccess] {
            let send = CodeCall {
                mode,
                ceiling: ceiling(&[Effect::Read]),
                ..call("send_message", Risk::Write, Effect::SendAsPerson)
            };
            assert!(matches!(route(send), Route::Refuse(_)), "{mode:?}");
            let network = CodeCall {
                mode,
                ceiling: ceiling(&[]),
                ..call("bot_message", Risk::Write, Effect::Network)
            };
            assert!(matches!(route(network), Route::Refuse(_)), "{mode:?}");
        }
    }

    #[test]
    fn what_a_reviewer_would_read_goes_to_the_person_and_credentials_are_refused() {
        let network = call("bot_message", Risk::Write, Effect::Network);
        assert!(asks(&route(network)));
        let secrets = CodeCall {
            credentials: true,
            ..call("workspace_read", Risk::Read, Effect::Read)
        };
        assert!(matches!(route(secrets), Route::Refuse(_)));
    }
}

mod http {
    use crate::autonomy::Mode;
    use crate::effect::ceiling::{Ceiling, Effects};
    use crate::effect::{Effect, Route};
    use crate::org::{Gate, Policy};
    use crate::package::code::run::{HttpCall, http_route};

    fn ceiling(allows: &[Effect]) -> Option<Ceiling<'static>> {
        Some(Ceiling {
            bot: "Fares",
            allows: allows.iter().copied().collect::<Effects>(),
        })
    }

    fn acme(body: &str) -> Option<Gate<'static>> {
        let policy = Box::leak(Box::new(
            Policy::parse(body).unwrap_or_else(|| panic!("a policy")),
        ));
        Some(Gate {
            org: "Acme",
            policy,
        })
    }

    fn request(mode: Mode) -> HttpCall<'static> {
        HttpCall {
            tainted: false,
            mode,
            ceiling: ceiling(&[Effect::Network]),
            org: None,
        }
    }

    #[test]
    fn each_request_runs_only_while_the_ceiling_and_the_organization_allow_it_in_every_mode() {
        for mode in [Mode::AutoReview, Mode::FullAccess] {
            assert_eq!(http_route(request(mode)), Route::Run, "{mode:?}");
            // The person turned network off since the call was decided.
            let off = HttpCall {
                ceiling: ceiling(&[]),
                ..request(mode)
            };
            assert!(matches!(http_route(off), Route::Refuse(_)), "{mode:?}");
            // The organization's policy turned network off since.
            let forbidden = HttpCall {
                org: acme(r#"{"effects": {"network_without_hosts": "off"}}"#),
                ..request(mode)
            };
            assert!(
                matches!(http_route(forbidden), Route::Refuse(ref why) if why.contains("Acme")),
                "{mode:?}"
            );
        }
    }

    #[test]
    fn a_request_after_untrusted_content_or_on_a_shared_bot_goes_to_a_person() {
        let tainted = HttpCall {
            tainted: true,
            ..request(Mode::AutoReview)
        };
        assert!(matches!(http_route(tainted), Route::Ask { .. }));
        // A shared bot's outward step needs a member's say, each request.
        let shared = HttpCall {
            org: acme("{}"),
            ..request(Mode::FullAccess)
        };
        assert!(matches!(http_route(shared), Route::Ask { .. }));
    }
}

#[test]
fn a_calls_log_of_tools_is_bounded_whatever_the_component_sends() {
    let mut log = CallLog::default();
    let huge = "x".repeat(1024 * 1024);
    for _ in 0..10_000 {
        log.push(&huge, "refused");
    }
    let kept: usize = log.lines().iter().map(String::len).sum();
    assert!(kept <= MOST_CALL_BYTES + 32, "{kept}");
    assert!(log.lines().len() <= MOST_CALL_LINES + 1);
    assert_eq!(log.len(), 10_000);
    assert!(log.lines().last().is_some_and(|l| l.starts_with("and ")));
    // A long name is cut to the limit in the log.
    let mut one = CallLog::default();
    one.push(&"y".repeat(100), "refused");
    assert_eq!(
        one.lines(),
        vec![format!("{}: refused", "y".repeat(MOST_CALL_NAME))]
    );
    // A name past the limit is refused, without echoing it.
    let refused = call_refusal(&huge).unwrap_or_default();
    assert!(refused.len() < 200, "{}", refused.len());
}
