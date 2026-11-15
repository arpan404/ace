use std::collections::HashMap;

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
}

fn table() -> Table {
    Table(HashMap::from([
        ("a/strong", Some(30.0)),
        ("a/mid", Some(12.0)),
        ("a/fast", Some(1.5)),
        ("b/stronger", Some(90.0)),
        ("local/llama", None),
    ]))
}

fn overrides(roles: &[(Role, &str)]) -> Overrides {
    Overrides {
        roles: roles.iter().map(|(r, m)| (*r, (*m).to_owned())).collect(),
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
    for role in [Role::Helper, Role::Compact, Role::Title, Role::Review] {
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
fn the_verifier_defaults_to_the_strongest_model_in_use_that_is_not_the_bots() {
    let none = Overrides::default();
    assert_eq!(
        choose("a/strong", &none, &none, &with_fast(), Role::Verify),
        ("b/stronger".to_owned(), Source::Default)
    );
    // Only weaker models in use: the bot's own checks rather than a weaker one.
    let weaker = Defaults {
        fast: Some("a/fast".to_owned()),
        in_use: vec!["a/mid".to_owned()],
    };
    assert_eq!(
        choose("a/strong", &none, &none, &weaker, Role::Verify),
        ("a/strong".to_owned(), Source::Own)
    );
    // An unpriced bot can't be compared: its own model checks.
    assert_eq!(
        choose("local/llama", &none, &none, &with_fast(), Role::Verify),
        ("local/llama".to_owned(), Source::Own)
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
fn one_shot_roles_never_run_on_a_subscription() {
    let bot = overrides(&[(Role::Compact, "cli:codex/gpt-6.1-sol")]);
    let none = Overrides::default();
    let mut models = table();
    models.0.insert("cli:codex/gpt-6.1-sol", None);
    let routing = Routing {
        own: "a/strong",
        bot: &bot,
        global: &none,
        defaults: &with_fast(),
        models: &models,
    };
    assert_eq!(routing.resolve(Role::Compact).model, "a/fast");
    assert!(routing.pick("cli:codex/gpt-6.1-sol").is_err());
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
fn the_budget_note_says_what_was_spent_what_is_left_and_each_roles_model() {
    let budget = Budget {
        today_micros: 1_200_000,
        month_micros: 8_000_000,
        daily_cap_micros: Some(5_000_000),
        monthly_cap_micros: None,
        today_by_role: vec![(Role::Main, 1_000_000), (Role::Helper, 200_000)],
        roles: vec![
            (Role::Main, "a/strong".into()),
            (Role::Helper, "a/fast".into()),
        ],
    };
    assert_eq!(
        note(&budget),
        "<budget>Spent today $1.20 of the $5.00 cap ($3.80 left); this month $8.00 (no cap). \
         Today by role: main $1.00, helper $0.20. Models: main a/strong, helper a/fast. Pass a \
         cheaper role as helper's model for sub-work; this is information, not a limit.</budget>"
    );
    // Past the cap nothing goes negative.
    let over = Budget {
        today_micros: 6_000_000,
        daily_cap_micros: Some(5_000_000),
        ..Budget::default()
    };
    assert!(note(&over).contains("($0.00 left)"));
}

#[test]
fn overrides_round_trip_as_role_names() {
    let stored = Overrides {
        roles: [(Role::Verify, "b/stronger".to_owned())].into(),
        allowed: None,
        escalate: Some(true),
    };
    let text = serde_json::to_string(&stored).unwrap_or_default();
    assert_eq!(text, r#"{"roles":{"verify":"b/stronger"},"escalate":true}"#);
    let read: Overrides = serde_json::from_str(&text).unwrap_or_default();
    assert_eq!(read, stored);
}
