use std::collections::{BTreeMap, HashMap};

use super::*;

/// The person's endpoints: each configured model with its price (input plus output).
struct Table(HashMap<&'static str, Option<f64>>);

impl Models for Table {
    fn configured(&self, reference: &str) -> bool {
        self.0.contains_key(reference)
    }
    fn strength(&self, reference: &str) -> Option<f64> {
        self.0.get(reference).copied().flatten()
    }
    /// `local/tiny` didn't call tools in Spade's check.
    fn calls_tools(&self, reference: &str) -> bool {
        reference != "local/tiny"
    }
}

fn table() -> Table {
    Table(HashMap::from([
        ("a/strong", Some(30.0)),
        ("a/mid", Some(12.0)),
        ("a/fast", Some(1.5)),
        ("b/stronger", Some(90.0)),
        ("local/llama", None),
        ("local/tiny", None),
    ]))
}

fn overrides(roles: &[(Role, &str)]) -> Overrides {
    Overrides {
        roles: roles.iter().map(|(r, m)| (*r, Route::one(m))).collect(),
        ..Overrides::default()
    }
}

fn choose(
    own: &str,
    bot: &Overrides,
    global: &Overrides,
    defaults: &Defaults,
    role: Role,
) -> (String, Source) {
    let models = table();
    let routing = Routing {
        own,
        bot,
        global,
        defaults,
        models: &models,
    };
    let choice = routing.resolve(role);
    (choice.model, choice.source)
}

fn with_fast() -> Defaults {
    Defaults {
        fast: Some("a/fast".to_owned()),
        in_use: vec!["a/mid".to_owned(), "b/stronger".to_owned()],
    }
}

#[test]
fn sub_work_defaults_to_the_fast_model_and_main_is_always_the_bots_own() {
    let none = Overrides::default();
    for role in [Role::Helper, Role::Compact, Role::Title] {
        assert_eq!(
            choose("a/strong", &none, &none, &with_fast(), role),
            ("a/fast".to_owned(), Source::Default),
            "{role:?}"
        );
    }
    let everything = overrides(&[(Role::Main, "a/fast")]);
    assert_eq!(
        choose(
            "a/strong",
            &everything,
            &everything,
            &with_fast(),
            Role::Main
        ),
        ("a/strong".to_owned(), Source::Own)
    );
}

#[test]
fn with_no_fast_model_or_a_fast_bot_sub_work_stays_on_the_bots_model() {
    let none = Overrides::default();
    let no_fast = Defaults::default();
    assert_eq!(
        choose("a/strong", &none, &none, &no_fast, Role::Helper),
        ("a/strong".to_owned(), Source::Own)
    );
    assert_eq!(
        choose("a/fast", &none, &none, &with_fast(), Role::Helper),
        ("a/fast".to_owned(), Source::Own)
    );
}

#[test]
fn the_verifier_and_the_reviewer_default_to_the_strongest_model_in_use_never_a_weaker_one() {
    let none = Overrides::default();
    for role in [Role::Verify, Role::Review] {
        assert_eq!(
            choose("a/strong", &none, &none, &with_fast(), role),
            ("b/stronger".to_owned(), Source::Default),
            "{role:?}"
        );
        // Only weaker models in use: the bot's own checks rather than a weaker one.
        let weaker = Defaults {
            fast: Some("a/fast".to_owned()),
            in_use: vec!["a/mid".to_owned()],
        };
        assert_eq!(
            choose("a/strong", &none, &none, &weaker, role),
            ("a/strong".to_owned(), Source::Own),
            "{role:?}"
        );
    }
    // An unpriced bot can't be compared: its own model verifies, and the fast model reviews,
    // as it did before.
    assert_eq!(
        choose("local/llama", &none, &none, &with_fast(), Role::Verify),
        ("local/llama".to_owned(), Source::Own)
    );
    assert_eq!(
        choose("local/llama", &none, &none, &with_fast(), Role::Review),
        ("a/fast".to_owned(), Source::Default)
    );
}

#[test]
fn the_bots_override_beats_the_global_one_and_a_gone_model_is_skipped() {
    let bot = overrides(&[(Role::Helper, "a/mid")]);
    let global = overrides(&[(Role::Helper, "local/llama"), (Role::Title, "a/mid")]);
    let defaults = with_fast();
    assert_eq!(
        choose("a/strong", &bot, &global, &defaults, Role::Helper),
        ("a/mid".to_owned(), Source::Bot)
    );
    assert_eq!(
        choose("a/strong", &bot, &global, &defaults, Role::Title),
        ("a/mid".to_owned(), Source::Global)
    );
    let gone = overrides(&[(Role::Helper, "gone/model")]);
    assert_eq!(
        choose("a/strong", &gone, &global, &defaults, Role::Helper),
        ("local/llama".to_owned(), Source::Global)
    );
}

#[test]
fn a_call_names_a_role_or_a_configured_model_and_nothing_else() {
    let none = Overrides::default();
    let models = table();
    let defaults = with_fast();
    let routing = Routing {
        own: "a/strong",
        bot: &none,
        global: &none,
        defaults: &defaults,
        models: &models,
    };
    assert_eq!(routing.pick("helper").as_deref(), Ok("a/fast"));
    assert_eq!(routing.pick("main").as_deref(), Ok("a/strong"));
    assert_eq!(routing.pick(" a/mid ").as_deref(), Ok("a/mid"));
    let refused = routing.pick("openai/gpt-9").err().unwrap_or_default();
    assert!(refused.contains("openai/gpt-9 is not a model"), "{refused}");
    assert!(refused.contains("helper (a/fast)"), "{refused}");
}

#[test]
fn a_bot_narrowed_to_a_list_names_only_models_on_it() {
    let bot = Overrides {
        allowed: Some(vec!["a/mid".to_owned(), "gone/x".to_owned()]),
        ..Overrides::default()
    };
    let none = Overrides::default();
    let models = table();
    let defaults = with_fast();
    let routing = Routing {
        own: "a/strong",
        bot: &bot,
        global: &none,
        defaults: &defaults,
        models: &models,
    };
    assert_eq!(routing.pick("a/mid").as_deref(), Ok("a/mid"));
    // Roles stay open: the person chose them.
    assert_eq!(routing.pick("helper").as_deref(), Ok("a/fast"));
    let refused = routing.pick("b/stronger").err().unwrap_or_default();
    assert!(
        refused.ends_with("or one of these models: a/mid."),
        "{refused}"
    );
}

#[test]
fn escalation_follows_the_bot_then_the_global_setting_and_is_off_by_default() {
    let models = table();
    let defaults = Defaults::default();
    let on = Overrides {
        escalate: Some(true),
        ..Overrides::default()
    };
    let off = Overrides {
        escalate: Some(false),
        ..Overrides::default()
    };
    let none = Overrides::default();
    let escalates = |bot: &Overrides, global: &Overrides| {
        Routing {
            own: "a/strong",
            bot,
            global,
            defaults: &defaults,
            models: &models,
        }
        .escalate()
    };
    assert!(!escalates(&none, &none));
    assert!(escalates(&none, &on));
    assert!(!escalates(&off, &on));
}

#[test]
fn failed_or_not_yet_work_on_another_model_reruns_once_on_the_bots_own() {
    use Outcome::*;
    let cases = [
        (true, 0, Failed, "a/fast", Some("a/strong")),
        (true, 0, NotYet, "a/fast", Some("a/strong")),
        (true, 0, Done, "a/fast", None),
        (true, 0, Stopped, "a/fast", None),
        (true, 1, Failed, "a/fast", None),
        (true, 0, Failed, "a/strong", None),
        (false, 0, Failed, "a/fast", None),
    ];
    for (on, attempt, outcome, ran_on, expected) in cases {
        assert_eq!(
            escalate_to(on, attempt, outcome, ran_on, "a/strong"),
            expected,
            "{on} {attempt} {outcome:?} {ran_on}"
        );
    }
}

#[test]
fn a_rerun_is_its_jobs_second_attempt_and_never_has_a_third() {
    let rerun = retry_job("call_7");
    assert_eq!(base_job(&rerun), "call_7");
    assert_eq!((attempt("call_7"), attempt(&rerun)), (0, 1));
    assert_eq!(retry_job(&rerun), rerun);
}

#[test]
fn overrides_round_trip_as_role_names() {
    let stored = Overrides {
        roles: [(Role::Verify, Route::one("b/stronger"))].into(),
        allowed: None,
        escalate: Some(true),
        efforts: BTreeMap::new(),
        context_tokens: None,
        age_results: None,
    };
    let text = serde_json::to_string(&stored).unwrap_or_default();
    assert_eq!(
        text,
        r#"{"roles":{"verify":["b/stronger"]},"escalate":true}"#
    );
    let read: Overrides = serde_json::from_str(&text).unwrap_or_default();
    assert_eq!(read, stored);
    // What an older build stored, one model per role, reads as a route of one.
    let older: Overrides =
        serde_json::from_str(r#"{"roles":{"verify":"b/stronger"},"escalate":true}"#)
            .unwrap_or_default();
    assert_eq!(older, stored);
}

fn route_of(own: &str, bot: &Overrides, global: &Overrides, role: Role) -> Vec<String> {
    let models = table();
    let defaults = with_fast();
    Routing {
        own,
        bot,
        global,
        defaults: &defaults,
        models: &models,
    }
    .route(role)
}

fn routes(roles: &[(Role, &[&str])]) -> Overrides {
    Overrides {
        roles: roles
            .iter()
            .map(|(role, list)| (*role, Route(list.iter().map(|m| (*m).to_owned()).collect())))
            .collect(),
        ..Overrides::default()
    }
}

#[test]
fn the_main_route_is_the_bots_own_model_then_its_fallbacks_in_order() {
    let none = Overrides::default();
    let global = routes(&[(Role::Main, &["local/llama", "a/mid"])]);
    assert_eq!(
        route_of("a/strong", &none, &global, Role::Main),
        ["a/strong", "local/llama", "a/mid"]
    );
    // The bot's own route wins over the global one, and the bot's model is never listed twice.
    let bot = routes(&[(Role::Main, &["a/strong", "b/stronger"])]);
    assert_eq!(
        route_of("a/strong", &bot, &global, Role::Main),
        ["a/strong", "b/stronger"]
    );
    // With no route, the bot's model alone.
    assert_eq!(route_of("a/strong", &none, &none, Role::Main), ["a/strong"]);
}

#[test]
fn a_route_skips_gone_models_and_holds_at_most_four() {
    let none = Overrides::default();
    let long = routes(&[(
        Role::Main,
        &["gone/x", "a/mid", "a/fast", "b/stronger", "local/llama"],
    )]);
    assert_eq!(
        route_of("a/strong", &long, &none, Role::Main),
        ["a/strong", "a/mid", "a/fast", "b/stronger"]
    );
    let helper = routes(&[(Role::Helper, &["gone/x", "a/mid", "a/fast"])]);
    assert_eq!(
        route_of("a/strong", &helper, &none, Role::Helper),
        ["a/mid", "a/fast"]
    );
    // A role with no route of its own tries its default alone.
    assert_eq!(route_of("a/strong", &none, &none, Role::Helper), ["a/fast"]);
}

#[test]
fn a_route_skips_an_old_subscription_reference() {
    let none = Overrides::default();
    // A subscription stored in a route by an older build (ADR 0133) is never tried.
    let stored = routes(&[
        (Role::Main, &["cli:claude/opus", "a/mid"]),
        (Role::Helper, &["cli:codex/gpt-6.1-sol"]),
    ]);
    assert_eq!(
        route_of("a/strong", &stored, &none, Role::Main),
        ["a/strong", "a/mid"]
    );
    assert_eq!(
        route_of("a/strong", &stored, &none, Role::Helper),
        ["a/fast"]
    );
}

#[test]
fn a_model_that_cant_call_tools_serves_only_titles_and_summaries() {
    let tiny = |roles: &[Role]| -> Overrides {
        Overrides {
            roles: roles
                .iter()
                .map(|r| (*r, Route(vec!["local/tiny".to_owned(), "a/mid".to_owned()])))
                .collect(),
            ..Overrides::default()
        }
    };
    let global = tiny(&Role::ALL);
    let defaults = Defaults {
        fast: Some("local/tiny".to_owned()),
        in_use: Vec::new(),
    };
    for role in [Role::Title, Role::Compact] {
        assert_eq!(
            choose("a/strong", &Overrides::default(), &global, &defaults, role),
            ("local/tiny".to_owned(), Source::Global),
            "{role:?}"
        );
    }
    for role in [Role::Helper, Role::Verify, Role::Review] {
        assert_eq!(
            choose("a/strong", &Overrides::default(), &global, &defaults, role),
            ("a/mid".to_owned(), Source::Global),
            "{role:?} passes over it"
        );
    }
    // Nor is it a fast default for helper work, a bot's fallback or a model it may name.
    let none = Overrides::default();
    assert_eq!(
        choose("a/strong", &none, &none, &defaults, Role::Helper),
        ("a/strong".to_owned(), Source::Own)
    );
    let models = table();
    let routing = Routing {
        own: "a/strong",
        bot: &none,
        global: &global,
        defaults: &defaults,
        models: &models,
    };
    assert_eq!(routing.route(Role::Main), vec!["a/strong", "a/mid"]);
    assert_eq!(routing.route(Role::Title), vec!["local/tiny", "a/mid"]);
    assert!(routing.pick("local/tiny").is_err());
}

fn efforts(pairs: &[(Role, Effort)]) -> Overrides {
    Overrides {
        efforts: pairs.iter().copied().collect(),
        ..Overrides::default()
    }
}

fn effort_of(bot: &Overrides, global: &Overrides, role: Role) -> (Effort, Source) {
    let models = table();
    let defaults = Defaults::default();
    Routing {
        own: "a/strong",
        bot,
        global,
        defaults: &defaults,
        models: &models,
    }
    .effort(role)
}

#[test]
fn turns_reviews_and_checks_think_at_medium_and_side_work_at_low_by_default() {
    let none = Overrides::default();
    for (role, effort) in [
        (Role::Main, Effort::Medium),
        (Role::Review, Effort::Medium),
        (Role::Verify, Effort::Medium),
        (Role::Helper, Effort::Low),
        (Role::Compact, Effort::Low),
        (Role::Title, Effort::Low),
    ] {
        assert_eq!(effort_of(&none, &none, role), (effort, Source::Default));
    }
}

#[test]
fn the_reviewer_thinks_at_medium_unless_the_bot_or_the_person_overrides_it() {
    let none = Overrides::default();
    let global = efforts(&[(Role::Review, Effort::High)]);
    let bot = efforts(&[(Role::Review, Effort::Provider)]);
    assert_eq!(
        effort_of(&none, &none, Role::Review),
        (Effort::Medium, Source::Default)
    );
    assert_eq!(
        effort_of(&none, &global, Role::Review),
        (Effort::High, Source::Global)
    );
    assert_eq!(
        effort_of(&bot, &global, Role::Review),
        (Effort::Provider, Source::Bot)
    );
    // Another role keeps its own default.
    assert_eq!(
        effort_of(&bot, &global, Role::Title),
        (Effort::Low, Source::Default)
    );
}

#[test]
fn efforts_stored_by_name_read_back_and_older_overrides_read_with_none()
-> Result<(), serde_json::Error> {
    let stored = efforts(&[(Role::Main, Effort::Off), (Role::Verify, Effort::Max)]);
    let json = serde_json::to_string(&stored)?;
    assert_eq!(json, r#"{"efforts":{"main":"off","verify":"max"}}"#);
    assert_eq!(serde_json::from_str::<Overrides>(&json)?, stored);
    let older: Overrides = serde_json::from_str(r#"{"roles":{"title":"a/fast"}}"#)?;
    assert!(older.efforts.is_empty());
    Ok(())
}

#[test]
fn an_effort_word_this_build_doesnt_know_is_skipped_and_the_rest_of_the_overrides_still_read()
-> Result<(), serde_json::Error> {
    let stored = r#"{"roles":{"verify":["b/stronger"]},"allowed":["a/fast"],"escalate":true,
        "efforts":{"review":"extreme","title":"low","advisor":"high"}}"#;
    let read: Overrides = serde_json::from_str(stored)?;
    assert_eq!(read.roles[&Role::Verify], Route::one("b/stronger"));
    assert_eq!(read.allowed, Some(vec!["a/fast".to_owned()]));
    assert_eq!(read.escalate, Some(true));
    assert_eq!(read.efforts, [(Role::Title, Effort::Low)].into());
    Ok(())
}

#[test]
fn the_task_role_resolves_like_the_others_and_defaults_to_whatever_main_resolves_to() {
    let none = Overrides::default();
    // Unset: tasks run on the chat's model and route, fallbacks included, never the fast model.
    assert_eq!(
        choose("a/strong", &none, &none, &with_fast(), Role::Task),
        ("a/strong".to_owned(), Source::Own)
    );
    let main_route = routes(&[(Role::Main, &["a/strong", "a/mid"])]);
    assert_eq!(
        route_of("a/strong", &main_route, &none, Role::Task),
        ["a/strong", "a/mid"]
    );
    // The global choice, then the bot's own, win as for any role; a gone model is skipped.
    let global = overrides(&[(Role::Task, "a/mid")]);
    let bot = overrides(&[(Role::Task, "b/stronger")]);
    let gone = overrides(&[(Role::Task, "gone/x")]);
    assert_eq!(
        choose("a/strong", &none, &global, &with_fast(), Role::Task),
        ("a/mid".to_owned(), Source::Global)
    );
    assert_eq!(
        choose("a/strong", &bot, &global, &with_fast(), Role::Task),
        ("b/stronger".to_owned(), Source::Bot)
    );
    assert_eq!(
        choose("a/strong", &gone, &global, &with_fast(), Role::Task),
        ("a/mid".to_owned(), Source::Global)
    );
    assert_eq!(
        route_of("a/strong", &bot, &global, Role::Task),
        ["b/stronger"]
    );
}

#[test]
fn a_tasks_effort_follows_mains_until_the_person_sets_its_own() {
    let none = Overrides::default();
    assert_eq!(
        effort_of(&none, &none, Role::Task),
        (Effort::Medium, Source::Default)
    );
    // Changing main's effort changes tasks' too.
    let main_high = efforts(&[(Role::Main, Effort::High)]);
    assert_eq!(
        effort_of(&main_high, &none, Role::Task),
        (Effort::High, Source::Default)
    );
    // Its own effort, globally or per bot, beats main's.
    let global = efforts(&[(Role::Task, Effort::Low)]);
    assert_eq!(
        effort_of(&main_high, &global, Role::Task),
        (Effort::Low, Source::Global)
    );
    let bot = efforts(&[(Role::Main, Effort::High), (Role::Task, Effort::Max)]);
    assert_eq!(
        effort_of(&bot, &global, Role::Task),
        (Effort::Max, Source::Bot)
    );
    assert_eq!(Role::parse("task"), Some(Role::Task));
}
