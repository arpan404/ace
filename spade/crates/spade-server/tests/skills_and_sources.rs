//! The skill library and live tool sources through the real engine and API: the skill index is
//! frozen into a conversation's instructions, skills load by name, and tools that arrive while
//! Spade runs are found with tool_search without changing the tools sent to the model.

mod support;

use std::sync::{Arc, Mutex};

use serde_json::json;
use spade_core::skills::SkillEntry;
use spade_core::tools::Risk;
use spade_server::tools::{LibraryFuture, SkillLibrary, SkillLoad, SkillSearch, Tool, ToolSource};
use spade_testkit::Script;
use support::{FakeTool, Options, Result, Spade};

/// A skill library whose list can change, counting how often it is listed.
#[derive(Default)]
struct Library {
    skills: Mutex<Vec<SkillEntry>>,
}

impl Library {
    fn with(names: &[(&str, &str)]) -> Arc<Self> {
        let library = Self::default();
        *library.skills.lock().unwrap_or_else(|p| p.into_inner()) = names
            .iter()
            .map(|(name, description)| SkillEntry {
                id: format!("skl_{name}"),
                name: (*name).into(),
                description: (*description).into(),
                manual: false,
            })
            .collect();
        Arc::new(library)
    }

    fn add(&self, name: &str) {
        self.skills
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(SkillEntry {
                id: format!("skl_{name}"),
                name: name.into(),
                description: "added later".into(),
                manual: false,
            });
    }
}

impl SkillLibrary for Library {
    fn list(&self) -> LibraryFuture<Vec<SkillEntry>> {
        let skills = self
            .skills
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        Box::pin(async move { Ok(skills) })
    }

    fn read(&self, id: &str) -> LibraryFuture<String> {
        let text = format!("Steps for {id}: check, then ship.");
        Box::pin(async move { Ok(text) })
    }
}

fn skill_tools(library: &Arc<Library>) -> Vec<Arc<dyn Tool>> {
    let library: Arc<dyn SkillLibrary> = library.clone();
    vec![
        Arc::new(SkillSearch(library.clone())),
        Arc::new(SkillLoad::new(library)),
    ]
}

fn with_library(library: &Arc<Library>) -> Options {
    Options {
        skills: Some(library.clone() as Arc<dyn SkillLibrary>),
        ..Default::default()
    }
}

#[tokio::test]
async fn the_skill_index_is_frozen_at_the_first_reply_and_skills_load_by_name() -> Result {
    let library = Library::with(&[
        ("release", "Ship a release"),
        ("review-code", "Review a branch"),
    ]);
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "skill_load", json!({ "name": "release" })),
            Script::reply("Released."),
            Script::reply("").plain(r#"{"title":"Release"}"#),
            Script::reply("Done again."),
        ],
        skill_tools(&library),
        with_library(&library),
    )
    .await?;
    let id = spade.ask("Ship it").await?;
    spade.wait_for(&id, "renamed").await?;
    library.add("deploy");
    spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Again" }),
        )
        .await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;

    let seen = spade.fake.seen();
    let system = |n: usize| {
        seen[n].body["messages"][0]["content"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    };
    assert!(
        system(0).contains("- release: Ship a release"),
        "{}",
        system(0)
    );
    assert_eq!(
        system(0),
        system(3),
        "the index never changes within a conversation"
    );
    assert!(!system(3).contains("deploy"));
    let second = seen[1].body["messages"].to_string();
    assert!(
        second.contains("Steps for skl_release: check, then ship."),
        "{second}"
    );
    Ok(())
}

/// A tool source whose list the test changes while Spade runs.
#[derive(Default)]
struct Live(Mutex<Vec<Arc<dyn Tool>>>);

impl ToolSource for Live {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

#[tokio::test]
async fn a_tool_that_arrives_later_is_found_and_run_without_changing_the_offered_tools() -> Result {
    let live = Arc::new(Live::default());
    let spade = Spade::start_with_source(
        vec![
            Script::reply("Nothing to start agents with yet."),
            Script::reply("").plain(r#"{"title":"Agents"}"#),
            Script::reply("").call(
                "c1",
                "tool_search",
                json!({ "query": "start agent thread" }),
            ),
            Script::reply("").call(
                "c2",
                "call_tool",
                json!({ "name": "thread_start", "arguments": { "title": "Fix the bug" } }),
            ),
        ],
        Vec::new(),
        live.clone(),
    )
    .await?;
    let id = spade.ask("Start an agent").await?;
    spade.wait_for(&id, "renamed").await?;

    let start = FakeTool::new("thread_start", Risk::Write, "started thread t1")
        .deferred("Start an ace agent thread");
    *live.0.lock().unwrap_or_else(|p| p.into_inner()) = vec![Arc::new(start) as Arc<dyn Tool>];
    spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Try now" }),
        )
        .await?;
    let events = spade.wait_for(&id, "approval_requested").await?;
    let asked = events.iter().find(|e| e["type"] == "approval_requested");
    assert_eq!(
        asked.map(|e| e["name"].clone()),
        Some(json!("thread_start"))
    );

    let seen = spade.fake.seen();
    let names = |n: usize| -> Vec<String> {
        seen[n].body["tools"]
            .as_array()
            .map(|t| {
                t.iter()
                    .map(|t| t["function"]["name"].as_str().unwrap_or("").to_owned())
                    .collect()
            })
            .unwrap_or_default()
    };
    assert_eq!(
        names(0),
        vec![
            "ask_user",
            "bot_message",
            "bots_list",
            "history_read",
            "history_search",
            "memory_forget",
            "memory_save",
            "memory_search",
            "memory_update",
            "routine_delete",
            "routine_save",
            "routines_list",
            "tool_search",
            "call_tool"
        ],
        "search is offered before any tool arrives"
    );
    assert_eq!(names(0), names(3), "the offered tools never change");
    let found = seen[3].body["messages"].to_string();
    assert!(
        found.contains("thread_start: Start an ace agent thread"),
        "{found}"
    );
    Ok(())
}
