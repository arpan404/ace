use super::*;
use Effect::{Drive, Network, Read, SendAsPerson, WriteLocal};

/// `spade.v1` as published in 0.0.24. Packages are built against these names and effects, so this
/// list only ever grows: a row is never removed or lowered, and a tool may not drop out of the
/// table or read as stronger than here without an alias (ADR 0200 §4.3). `None`: `call_tool`, whose
/// effect is the called tool's.
const PUBLISHED_V1: &[(&str, Option<Effect>)] = &[
    ("task_goal", Some(WriteLocal)),
    ("task_plan", Some(WriteLocal)),
    ("task_status", Some(WriteLocal)),
    ("task_update", Some(WriteLocal)),
    ("todo", Some(WriteLocal)),
    ("profile_update", Some(WriteLocal)),
    ("memory_save", Some(WriteLocal)),
    ("memory_update", Some(WriteLocal)),
    ("memory_forget", Some(WriteLocal)),
    ("memory_search", Some(Read)),
    ("knowledge_write", Some(WriteLocal)),
    ("knowledge_update", Some(WriteLocal)),
    ("knowledge_forget", Some(WriteLocal)),
    ("knowledge_link", Some(WriteLocal)),
    ("knowledge_merge", Some(WriteLocal)),
    ("knowledge_read", Some(Read)),
    ("knowledge_search", Some(Read)),
    ("episode_search", Some(Read)),
    ("history_read", Some(Read)),
    ("history_search", Some(Read)),
    ("about_person", Some(Read)),
    ("workspace_list", Some(Read)),
    ("workspace_read", Some(Read)),
    ("workspace_search", Some(Read)),
    ("workspace_write", Some(WriteLocal)),
    ("workspace_edit", Some(WriteLocal)),
    ("document_read", Some(Read)),
    ("share_file", Some(WriteLocal)),
    ("shell", Some(WriteLocal)),
    ("service_start", Some(WriteLocal)),
    ("service_status", Some(Read)),
    ("service_logs", Some(Read)),
    ("service_stop", Some(WriteLocal)),
    ("web_search", Some(Read)),
    ("web_fetch", Some(Read)),
    ("research", Some(Read)),
    ("apps_find", Some(Read)),
    ("app_connect_request", Some(Read)),
    ("tool_search", Some(Read)),
    ("call_tool", None),
    ("bots_list", Some(Read)),
    ("bot_message", Some(Network)),
    ("group_ask", Some(WriteLocal)),
    ("club_add", Some(WriteLocal)),
    ("bot_create", Some(Network)),
    ("worker_message", Some(Network)),
    ("worker_status", Some(Read)),
    ("worker_result", Some(Read)),
    ("worker_stop", Some(WriteLocal)),
    ("helper", Some(WriteLocal)),
    ("delegate", Some(Network)),
    ("ask_user", Some(Read)),
    ("image_generate", Some(WriteLocal)),
    ("card_show", Some(WriteLocal)),
    ("routines_list", Some(Read)),
    ("routine_save", Some(WriteLocal)),
    ("routine_delete", Some(WriteLocal)),
    ("sleep_until", Some(WriteLocal)),
    ("wait_for", Some(WriteLocal)),
    ("wake_cancel", Some(WriteLocal)),
    ("browser_click", Some(Drive)),
    ("screen_act", Some(Drive)),
    ("sim_tap", Some(Drive)),
    ("git_push", Some(SendAsPerson)),
    ("pr_comment", Some(SendAsPerson)),
    ("issue_comment", Some(SendAsPerson)),
    ("send_message", Some(SendAsPerson)),
];

/// The published rows [`breaks`] checks: `call_tool`'s varies, so only its presence counts.
fn published() -> Vec<(&'static str, Effect)> {
    PUBLISHED_V1
        .iter()
        .map(|(name, effect)| (*name, effect.unwrap_or(Effect::Credential)))
        .collect()
}

#[test]
fn every_published_v1_tool_is_still_there_with_no_stronger_effect() {
    assert_eq!(breaks(&published(), now, ALIASES), Vec::<String>::new());
    for (name, was) in PUBLISHED_V1 {
        assert_eq!(effect(name), *was, "{name}");
    }
}

#[test]
fn removing_a_v1_tool_without_an_alias_breaks_the_version() {
    let without_shell = |name: &str| if name == "shell" { None } else { now(name) };
    assert_eq!(
        breaks(&published(), without_shell, &[]),
        vec!["shell: gone without an alias".to_owned()]
    );
}

#[test]
fn a_v1_tool_given_a_stronger_effect_without_an_alias_breaks_the_version() {
    let louder = |name: &str| {
        if name == "web_fetch" {
            Some(Some(Network))
        } else {
            now(name)
        }
    };
    assert_eq!(
        breaks(&published(), louder, &[]),
        vec!["web_fetch: its effect rose from read to network without an alias".to_owned()]
    );
    // A weaker one is a minor change.
    let quieter = |name: &str| {
        if name == "bot_message" {
            Some(Some(Read))
        } else {
            now(name)
        }
    };
    assert!(breaks(&published(), quieter, &[]).is_empty());
}

#[test]
fn a_renamed_tool_keeps_its_old_name_only_through_an_alias_kept_six_months() {
    let renamed = |name: &str| match name {
        "web_fetch" => None,
        "web_read" => Some(Some(Read)),
        other => now(other),
    };
    let kept = Alias {
        name: "web_fetch",
        to: "web_read",
        from: "2027-01-10",
        until: "2027-07-10",
    };
    assert!(breaks(&published(), renamed, &[kept]).is_empty());
    let short = Alias {
        until: "2027-03-01",
        ..kept
    };
    assert_eq!(
        breaks(&published(), renamed, &[short]),
        vec!["web_fetch: its alias must be kept at least six months".to_owned()]
    );
    let dangling = Alias {
        to: "web_get",
        ..kept
    };
    assert_eq!(
        breaks(&published(), renamed, &[dangling]),
        vec!["web_fetch: gone without an alias".to_owned()]
    );
}

#[test]
fn every_tool_in_the_gates_table_is_in_the_api_or_named_internal() {
    for (name, _) in super::super::BUILTIN {
        let in_api = tool(name).is_some_and(|t| t.source == Source::Table);
        assert!(
            in_api ^ INTERNAL.contains(name),
            "{name} must be in exactly one of spade.v1 and INTERNAL"
        );
    }
    for api in TOOLS.iter().filter(|t| t.source == Source::Table) {
        assert!(
            super::super::table(api.name).is_some(),
            "{} reads its effect from the gate's table, which lacks it",
            api.name
        );
    }
}

#[test]
fn the_api_reads_effects_from_the_gates_table() {
    // The API's answer and the gate's are one lookup, so they can't disagree.
    for api in TOOLS.iter().filter(|t| t.source == Source::Table) {
        assert_eq!(
            effect(api.name),
            super::super::builtin(api.name, crate::tools::Risk::Write),
            "{}",
            api.name
        );
    }
}

#[test]
fn a_module_name_reads_back_as_its_module() {
    for module in Module::ALL {
        assert_eq!(Module::parse(module.name()), Some(module));
    }
    assert_eq!(Module::parse("kernel"), None);
}

#[test]
fn runtime_doc() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/runtime.md");
    let written = markdown();
    if std::env::var_os("SPADE_WRITE_RUNTIME_DOC").is_some() {
        std::fs::write(path, &written).unwrap_or_else(|e| panic!("writing {path}: {e}"));
    }
    let shipped = std::fs::read_to_string(path).unwrap_or_default();
    assert!(
        shipped == written,
        "spade/docs/runtime.md is not the table's reference; run \
         SPADE_WRITE_RUNTIME_DOC=1 cargo test -p spade-core runtime_doc"
    );
}
