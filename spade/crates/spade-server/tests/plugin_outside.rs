//! A plugin's hook the sandbox can't seal off (on Windows: one with network) runs only as often as
//! the person allows it outside the sandbox (ADR 0167). Not `unix`-only: the hook's command works
//! under `sh` and `cmd.exe` alike, so this runs on Windows too.

mod support;

use std::sync::Arc;

use serde_json::json;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::plugins::FakeAce;
use support::plugins::{answer_outside, bot, cant_seal, hook, of_type, outside_asks, plugin, wait};
use support::{FakeTool, Result, Spade, types};

#[tokio::test]
async fn a_hook_the_sandbox_cant_seal_off_runs_only_as_often_as_the_person_allows() -> Result {
    let marks = tempfile::tempdir()?;
    let marker = marks.path().join("ran.txt");
    let guard = plugin(
        "guard",
        &"e".repeat(64),
        "/nowhere",
        json!([]),
        json!([hook(
            "PreToolUse",
            // `echo ran>> "<path>"` appends one line under `sh` and `cmd.exe` alike.
            &format!("echo ran>> \"{}\"", marker.display()),
            Some("note")
        )]),
    );
    let note = FakeTool::new("note", Risk::Read, "noted");
    let mut scripts = Vec::new();
    for n in 1..=3 {
        scripts.push(Script::reply("").call(&format!("c{n}"), "note", json!({})));
        scripts.push(Script::reply("Done."));
        if n == 1 {
            scripts.push(Script::reply("").plain(r#"{"title":"Notes"}"#));
        }
    }
    let spade = Spade::start_with(
        scripts,
        vec![Arc::new(note) as Arc<dyn Tool>],
        cant_seal(FakeAce::with(vec![guard])),
    )
    .await?;
    let (_, chat) = bot(&spade, "Notes", &["guard"]).await?;
    let runs = || {
        std::fs::read_to_string(&marker)
            .map(|text| text.lines().count())
            .unwrap_or(0)
    };

    // Before the person answers: the hook is refused, never run plainly, and they are asked.
    spade.say(&chat, "Note it").await?;
    let events = wait(&spade, &chat, "reply_finished", 1).await?;
    assert_eq!(runs(), 0, "the hook ran before it was allowed");
    let ran = of_type(&events, "hook_ran");
    assert_eq!(ran[0]["outcomes"][0]["result"], "failed", "{ran:?}");
    let asks = outside_asks(&events);
    assert_eq!(asks.len(), 1, "{:?}", types(&events));
    assert_eq!(asks[0]["what"], "hook PreToolUse");

    // Allowed once: it runs at the next call, and only then.
    let id = asks[0]["id"].as_str().unwrap_or_default().to_owned();
    assert_eq!(answer_outside(&spade, &chat, &id, false).await?, 202);
    spade.say(&chat, "Again").await?;
    wait(&spade, &chat, "reply_finished", 2).await?;
    assert_eq!(runs(), 1, "the allowed hook should have run once");

    // The once is used up: refused again, and asked again.
    spade.say(&chat, "Once more").await?;
    let events = wait(&spade, &chat, "reply_finished", 3).await?;
    assert_eq!(runs(), 1, "a once-allowed hook ran twice");
    assert_eq!(outside_asks(&events).len(), 1, "{:?}", types(&events));
    Ok(())
}
