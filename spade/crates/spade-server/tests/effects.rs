//! Decisions on effects, not words (ADR 0171), through the API: a tool that declares nothing asks
//! the person once and Spade keeps the answer; a typed send goes to the person; a push runs within
//! its grant and goes to the person outside it; a bot set to run outside the sandbox has its
//! commands reviewed; a per-call request to run outside runs that call once; the machine's
//! defaults are inherited and a bot's own wins. The sandbox tests start real shells on macOS.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, Result, Spade};

const TITLE: &str = r#"{"title":"Work"}"#;
const APPROVE: &str = r#"{"verdict":"approve","reason":"It serves the task."}"#;

/// The input schema of an ace whose driving tools take `expect`.
fn holds_place() -> Value {
    json!({ "type": "object", "properties": { "expect": { "type": "object" } } })
}

fn ran(calls: &Arc<std::sync::Mutex<Vec<Value>>>) -> usize {
    calls.lock().map(|c| c.len()).unwrap_or(0)
}

fn requests(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .collect()
}

async fn answer(spade: &Spade, conversation: &str, call: &str, body: Value) -> Result {
    let (status, answered) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/{call}"),
            body,
        )
        .await?;
    assert_eq!(status, 202, "{answered}");
    Ok(())
}

/// Waits until `calls` has `n` calls.
async fn until_ran(calls: &Arc<std::sync::Mutex<Vec<Value>>>, n: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while ran(calls) < n && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_tool_that_declares_nothing_asks_once_and_spade_keeps_the_answer() -> Result {
    let mystery = FakeTool::new("mystery", Risk::Write, "done").unannotated_app("Does a thing");
    let other = FakeTool::new("other", Risk::Write, "done").unannotated_app("Does another");
    let (mysteries, others) = (mystery.calls(), other.calls());
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "mystery", json!({})),
            Script::reply("Done."),
            Script::reply("").plain(TITLE),
            Script::reply("").call("c2", "mystery", json!({ "again": true })),
            Script::reply("Done again."),
            Script::reply("").call("c3", "other", json!({})),
            Script::reply("Asked."),
            Script::reply("").call("c4", "other", json!({})),
            Script::reply("Refused."),
        ],
        vec![
            Arc::new(mystery) as Arc<dyn Tool>,
            Arc::new(other) as Arc<dyn Tool>,
        ],
    )
    .await?;
    let agent = spade.new_agent("Builder", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Do the thing").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked = requests(&events);
    assert_eq!(asked[0]["ask"], "undeclared", "{asked:?}");
    assert_eq!(
        asked[0]["reviewer_reason"],
        "It doesn't say what it does, so you decide once for this bot."
    );
    answer(&spade, &conversation, "c1", json!({ "allowed": true })).await?;
    until_ran(&mysteries, 1).await;
    spade.wait_for(&conversation, "reply_finished").await?;
    // The next call of it runs without asking.
    spade.say(&conversation, "Again").await?;
    until_ran(&mysteries, 2).await;
    assert_eq!(ran(&mysteries), 2);
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(requests(&events).len(), 1, "asked once");
    // A tool the person declined is refused from then on, without asking again.
    spade.say(&conversation, "Try the other").await?;
    spade
        .wait_for_count(&conversation, "approval_requested", 2)
        .await?;
    answer(&spade, &conversation, "c3", json!({ "allowed": false })).await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 3)
        .await?;
    spade.say(&conversation, "Try it once more").await?;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 4)
        .await?;
    assert_eq!(requests(&events).len(), 2, "not asked again");
    let refused = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c4")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default();
    assert!(refused.contains("declined this tool"), "{refused}");
    assert_eq!(ran(&others), 0);
    Ok(())
}

#[tokio::test]
async fn a_typed_send_goes_to_the_person_and_no_reviewer() -> Result {
    let send = FakeTool::new("send_message", Risk::Write, "Sent");
    let sent = send.calls();
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "c1",
                "send_message",
                json!({ "app": "messages", "to": "+15551234567", "body": "On my way" }),
            ),
            // Only reached if a reviewer were asked: it would approve.
            Script::reply("").plain(APPROVE),
        ],
        vec![Arc::new(send) as Arc<dyn Tool>],
    )
    .await?;
    let agent = spade.new_agent("Builder", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Text Sam I'm on my way").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked = requests(&events);
    assert_eq!(
        asked[0]["reviewer_reason"],
        "It sends something in your name to +15551234567, so you decide."
    );
    assert_eq!(spade.fake.seen().len(), 1, "no reviewer was asked");
    assert_eq!(ran(&sent), 0);
    Ok(())
}

#[cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]
mod sandboxed {
    use super::*;
    use support::sandbox::{output, reviewed_world, world};

    #[tokio::test]
    async fn a_push_inside_its_grant_runs_and_any_other_goes_to_the_person() -> Result {
        let push = FakeTool::new("git_push", Risk::Write, "Pushed");
        let pushes = push.calls();
        let w = world(false, vec![Arc::new(push)], |_| {
            vec![
                Script::reply("").call(
                    "c1",
                    "git_push",
                    json!({ "repo": "acme/app", "branch": "spade/fix" }),
                ),
                Script::reply("Pushed."),
                Script::reply("").plain(TITLE),
                Script::reply("").call(
                    "c2",
                    "git_push",
                    json!({ "repo": "acme/app", "branch": "main" }),
                ),
            ]
        })
        .await?;
        let (status, granted) = w
            .spade
            .post(
                &format!("/v1/agents/{}/grants", w.bot),
                json!({ "kind": "git_push", "repo": "acme/*", "branch": "spade/*" }),
            )
            .await?;
        assert_eq!(status, 201, "{granted}");
        w.spade.say(&w.conversation, "Push the fix").await?;
        w.spade.wait_for(&w.conversation, "reply_finished").await?;
        assert_eq!(ran(&pushes), 1);
        w.spade.say(&w.conversation, "Now push main").await?;
        let events = w
            .spade
            .wait_for(&w.conversation, "approval_requested")
            .await?;
        let asked = requests(&events);
        assert_eq!(asked.len(), 1, "only the push outside the grant asks");
        assert_eq!(asked[0]["call_id"], "c2");
        assert_eq!(
            asked[0]["reviewer_reason"],
            "It pushes to github.com/acme/app, branch main with your sign-in, so you decide."
        );
        assert_eq!(ran(&pushes), 1);
        Ok(())
    }

    #[tokio::test]
    async fn a_bot_set_to_run_outside_the_sandbox_has_its_commands_reviewed() -> Result {
        let w = reviewed_world(true, vec![], |at| {
            let tax = at.home.join("Documents/tax.txt");
            vec![
                Script::reply("").call(
                    "c1",
                    "shell",
                    json!({ "command": format!("cat '{}'", tax.display()) }),
                ),
                Script::reply("").plain(APPROVE),
                Script::reply("Read it."),
            ]
        })
        .await?;
        let (status, view) = w
            .spade
            .put(
                &format!("/v1/agents/{}/security/commands", w.bot),
                json!({ "commands": "outside" }),
            )
            .await?;
        assert_eq!(status, 200, "{view}");
        assert_eq!(view["commands"], "outside");
        w.spade.say(&w.conversation, "Read my tax file").await?;
        let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
        let reviewed = events
            .iter()
            .find(|e| e["type"] == "call_reviewed")
            .ok_or_else(|| format!("not reviewed: {events:?}"))?;
        assert_eq!(reviewed["verdict"], "allow", "{reviewed}");
        assert_ne!(reviewed["model"], "", "a reviewer judged it");
        // It ran outside the sandbox: the person's file was readable.
        assert!(output(&events, "c1").contains("TAX-SECRET"), "{events:?}");
        Ok(())
    }

    #[tokio::test]
    async fn a_request_to_run_outside_runs_that_call_once_after_allow() -> Result {
        let w = world(true, vec![], |at| {
            let read = format!("cat '{}'", at.home.join("Documents/tax.txt").display());
            vec![
                Script::reply("").call(
                    "c1",
                    "shell",
                    json!({ "command": read, "outside_sandbox": true }),
                ),
                Script::reply("Read it."),
                Script::reply("").plain(TITLE),
                Script::reply("").call("c2", "shell", json!({ "command": read })),
                Script::reply("Blocked."),
                Script::reply("").call(
                    "c3",
                    "shell",
                    json!({ "command": read, "outside_sandbox": true }),
                ),
                Script::reply("Read it again."),
            ]
        })
        .await?;
        w.spade.say(&w.conversation, "Read my tax file").await?;
        let events = w
            .spade
            .wait_for(&w.conversation, "approval_requested")
            .await?;
        let asked = requests(&events);
        assert_eq!(asked[0]["ask"], "outside_sandbox", "{asked:?}");
        answer(&w.spade, &w.conversation, "c1", json!({ "allowed": true })).await?;
        let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
        assert!(output(&events, "c1").contains("TAX-SECRET"), "{events:?}");
        // Once: the next command runs sandboxed, and is told the sandbox stopped it.
        w.spade.say(&w.conversation, "And again").await?;
        let events = w
            .spade
            .wait_for_count(&w.conversation, "reply_finished", 2)
            .await?;
        let blocked = output(&events, "c2");
        assert!(!blocked.contains("TAX-SECRET"), "{blocked}");
        assert!(blocked.contains("outside_sandbox: true"), "{blocked}");
        assert_eq!(requests(&events).len(), 1);
        // Always for this bot: it runs, and the bot's commands run outside from then on.
        w.spade.say(&w.conversation, "Ask once more").await?;
        w.spade
            .wait_for_count(&w.conversation, "approval_requested", 2)
            .await?;
        answer(
            &w.spade,
            &w.conversation,
            "c3",
            json!({ "allowed": true, "always": true }),
        )
        .await?;
        let events = w
            .spade
            .wait_for_count(&w.conversation, "reply_finished", 3)
            .await?;
        assert!(output(&events, "c3").contains("TAX-SECRET"));
        let (_, view) = w
            .spade
            .get(&format!("/v1/agents/{}/security", w.bot))
            .await?;
        assert_eq!(view["commands"], "outside", "{view}");
        assert_eq!(view["own"]["commands"], true);
        Ok(())
    }

    #[tokio::test]
    async fn a_machine_default_is_inherited_and_a_bots_own_wins() -> Result {
        let w = world(false, vec![], |_| vec![]).await?;
        let bot = format!("/v1/agents/{}/security", w.bot);
        let (status, machine) = w
            .spade
            .put("/v1/security/commands", json!({ "commands": "outside" }))
            .await?;
        assert_eq!(status, 200, "{machine}");
        assert_eq!(machine["bots"]["commands"], "outside");
        let (_, view) = w.spade.get(&bot).await?;
        assert_eq!(view["commands"], "outside");
        assert_eq!(view["own"]["commands"], false);
        let (_, view) = w
            .spade
            .put(
                &format!("{bot}/commands"),
                json!({ "commands": "sandboxed" }),
            )
            .await?;
        assert_eq!(view["commands"], "sandboxed");
        assert_eq!(view["own"]["commands"], true);
        let (_, view) = w
            .spade
            .put(&format!("{bot}/commands"), json!({ "commands": null }))
            .await?;
        assert_eq!(view["commands"], "outside", "back to the machine's");
        // The network rules too.
        let (status, machine) = w
            .spade
            .put("/v1/security/network", json!({ "mode": "off" }))
            .await?;
        assert_eq!(status, 200, "{machine}");
        let (_, view) = w.spade.get(&bot).await?;
        assert_eq!(view["network"]["mode"], "off");
        assert_eq!(view["own"]["network"], false);
        let (_, view) = w
            .spade
            .put(&format!("{bot}/network"), json!({ "mode": "open" }))
            .await?;
        assert_eq!(view["network"]["mode"], "open");
        let (status, view) = w.spade.delete(&format!("{bot}/network")).await?;
        assert_eq!(status, 200, "{view}");
        assert_eq!(view["network"]["mode"], "off");
        let (status, refused) = w
            .spade
            .put(
                "/v1/security/network",
                json!({ "mode": "allow_list", "allow": ["not a host"] }),
            )
            .await?;
        assert_eq!(status, 400, "{refused}");
        Ok(())
    }

    #[tokio::test]
    async fn always_for_this_bot_moves_its_commands_outside_but_never_allows_one_unreviewed()
    -> Result {
        let w = world(true, vec![], |_| {
            let run = json!({ "command": "sh task.sh", "outside_sandbox": true });
            vec![
                Script::reply("").call("c1", "shell", run),
                Script::reply("Ran it."),
                Script::reply("").plain(TITLE),
                // The same command again, its script rewritten meanwhile.
                Script::reply("").call("c2", "shell", json!({ "command": "sh task.sh" })),
                Script::reply("Asked."),
            ]
        })
        .await?;
        let workspace = w.workspaces.of(&w.bot)?.path()?;
        std::fs::write(workspace.join("task.sh"), "echo first\n")?;
        w.spade.say(&w.conversation, "Run the task").await?;
        w.spade
            .wait_for(&w.conversation, "approval_requested")
            .await?;
        answer(
            &w.spade,
            &w.conversation,
            "c1",
            json!({ "allowed": true, "always": true }),
        )
        .await?;
        let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
        assert!(output(&events, "c1").contains("first"), "{events:?}");
        // The card's Always is the bot's setting, not an Always allow for the command.
        let answered = events
            .iter()
            .find(|e| e["type"] == "approval_answered")
            .cloned()
            .unwrap_or_default();
        assert_eq!(answered["always"], false, "{answered}");
        std::fs::write(workspace.join("task.sh"), "echo rewritten\n")?;
        w.spade.say(&w.conversation, "Again").await?;
        let events = w
            .spade
            .wait_for_count(&w.conversation, "approval_requested", 2)
            .await?;
        assert!(
            events
                .iter()
                .any(|e| e["type"] == "call_reviewed" && e["call_id"] == "c2"),
            "the rewritten script is reviewed: {events:?}"
        );
        assert!(output(&events, "c2").is_empty(), "not run unreviewed");
        Ok(())
    }

    #[tokio::test]
    async fn a_script_changed_after_allow_once_is_asked_again_on_what_it_runs_now() -> Result {
        let w = world(true, vec![], |_| {
            vec![
                Script::reply("").call(
                    "c1",
                    "shell",
                    json!({ "command": "sh task.sh", "outside_sandbox": true }),
                ),
                Script::reply("Stopped."),
            ]
        })
        .await?;
        let workspace = w.workspaces.of(&w.bot)?.path()?;
        std::fs::write(workspace.join("task.sh"), "echo as asked\n")?;
        w.spade.say(&w.conversation, "Run the task").await?;
        w.spade
            .wait_for(&w.conversation, "approval_requested")
            .await?;
        // Swapped while the card waits.
        std::fs::write(workspace.join("task.sh"), "echo swapped\n")?;
        answer(&w.spade, &w.conversation, "c1", json!({ "allowed": true })).await?;
        // The answer given on the old script never runs the new one: the person is asked again,
        // on the script as it is now, and only for this call.
        let events = w
            .spade
            .wait_for_count(&w.conversation, "approval_requested", 2)
            .await?;
        assert!(output(&events, "c1").is_empty(), "{events:?}");
        let again = events
            .iter()
            .rfind(|e| e["type"] == "approval_requested")
            .cloned()
            .unwrap_or_default();
        assert_eq!(again["stopped"], "changed", "{again}");
        assert_eq!(again["ask"], "outside_sandbox", "{again}");
        answer(&w.spade, &w.conversation, "c1", json!({ "allowed": true })).await?;
        let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
        let ran = output(&events, "c1");
        assert!(
            ran.contains("swapped"),
            "what the person allowed ran: {ran}"
        );
        assert!(!ran.contains("as asked"), "{ran}");
        Ok(())
    }

    /// Records what a push would start on the host, and answers each with success.
    #[derive(Default)]
    struct HostLog(std::sync::Mutex<Vec<Vec<String>>>);

    impl spade_server::tools::outward::Host for HostLog {
        fn run(
            &self,
            launch: spade_server::tools::outward::Launch,
        ) -> spade_server::tools::outward::HostFuture {
            let get_url = launch.args.iter().any(|a| a == "get-url");
            if let Ok(mut log) = self.0.lock() {
                log.push(launch.args);
            }
            Box::pin(async move {
                Ok(spade_server::tools::outward::HostRan {
                    code: Some(0),
                    stdout: if get_url {
                        "https://github.com/acme/app.git\n".to_owned()
                    } else {
                        String::new()
                    },
                    stderr: String::new(),
                })
            })
        }
    }

    fn git(dir: &std::path::Path, args: &[&str]) -> Result {
        let ran = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()?;
        assert!(ran.status.success(), "{args:?}: {ran:?}");
        Ok(())
    }

    /// A repository at `dir` with one commit of `file`, on `main`, with an origin.
    fn repository(dir: &std::path::Path, file: &str) -> Result {
        std::fs::create_dir_all(dir)?;
        git(dir, &["init", "-q"])?;
        std::fs::write(dir.join(file), file)?;
        git(dir, &["add", "."])?;
        git(dir, &["commit", "-q", "-m", "one"])?;
        git(
            dir,
            &["remote", "add", "origin", "https://github.com/acme/app.git"],
        )
    }

    #[tokio::test]
    async fn a_push_bundles_the_repository_in_the_sandbox_and_never_one_a_link_points_at() -> Result
    {
        let w = world(true, vec![], |_| vec![]).await?;
        w.bots.set(&w.spade.engine);
        let workspace = w.workspaces.of(&w.bot)?.path()?;
        repository(&workspace.join("app"), "fix.txt")?;
        // The bot's repository whose objects are a link to the person's private one.
        let private = w.home.join("code/private");
        repository(&private, "SECRET.txt")?;
        repository(&workspace.join("linked"), "decoy.txt")?;
        let objects = workspace.join("linked/.git/objects");
        std::fs::remove_dir_all(&objects)?;
        std::os::unix::fs::symlink(private.join(".git/objects"), &objects)?;
        let data = w.home.parent().map(|r| r.join("data")).unwrap_or_default();
        let host = Arc::new(HostLog::default());
        let tools = spade_server::tools::outward::outward_tools(
            w.workspaces.clone(),
            w.bots.clone(),
            host.clone(),
            Arc::new(spade_server::tools::outward::SandboxStage::new(
                w.shell.clone(),
            )),
            data.join("outward"),
        );
        let push = tools
            .iter()
            .find(|t| t.def().spec.name == "git_push")
            .ok_or("no git_push")?;
        let key = format!("{}.c1", w.conversation);
        let out = push
            .run(
                &key,
                json!({ "repo": "acme/app", "branch": "main", "path": "linked" }),
            )
            .await;
        assert!(
            out.is_error && out.content.contains("link"),
            "{}",
            out.content
        );
        assert!(host.0.lock().map(|l| l.is_empty()).unwrap_or(false));
        let out = push
            .run(
                &key,
                json!({ "repo": "acme/app", "branch": "main", "path": "app" }),
            )
            .await;
        assert!(!out.is_error, "{}", out.content);
        let log = host.0.lock().map(|l| l.clone()).unwrap_or_default();
        let fetch = log.iter().find(|a| a.iter().any(|w| w == "fetch")).cloned();
        assert!(
            fetch.is_some_and(|a| a.iter().any(|w| w.ends_with("push.bundle"))),
            "{log:?}"
        );
        Ok(())
    }

    #[tokio::test]
    async fn driving_textedit_is_reviewed_mail_asks_and_allowing_textedit_stops_the_asking()
    -> Result {
        let act = FakeTool::new(
            "screen_act",
            Risk::Write,
            "TextEdit (com.apple.TextEdit), frontmost\nWindow: \"Untitled\"",
        )
        .declares(spade_core::effect::Effect::Drive)
        .schema(holds_place());
        let acts = act.calls();
        // ace's list of apps, asked right before each step.
        let apps = FakeTool::new(
            "screen_apps",
            Risk::Read,
            "Running:\nTextEdit (com.apple.TextEdit), frontmost\nMail (com.apple.mail)",
        );
        let click = |id: &str, app: &str| {
            Script::reply("").call(
                id,
                "screen_act",
                json!({ "app": app, "actions": [{ "type": "click", "id": 3 }] }),
            )
        };
        let unreadable = "I can't tell.";
        let w = reviewed_world(false, vec![Arc::new(act), Arc::new(apps)], |_| {
            vec![
                click("c1", "TextEdit"),
                Script::reply("").plain(APPROVE),
                Script::reply("Clicked."),
                Script::reply("").plain(TITLE),
                Script::reply("").call(
                    "c2",
                    "screen_act",
                    json!({ "app": "Mail", "actions": [{ "type": "type", "text": "hi" }] }),
                ),
                Script::reply("Left it."),
                click("c3", "TextEdit"),
                // The reviewer can't decide, so it is left to the person.
                Script::reply("").plain(unreadable),
                Script::reply("").plain(unreadable),
                Script::reply("Clicked again."),
                click("c4", "TextEdit"),
                Script::reply("").plain(APPROVE),
                Script::reply("Done."),
            ]
        })
        .await?;
        // A click in TextEdit goes to the reviewer, not the person.
        w.spade.say(&w.conversation, "Click in TextEdit").await?;
        w.spade.wait_for(&w.conversation, "reply_finished").await?;
        assert_eq!(ran(&acts), 1);
        // Typing in Mail asks the person, and offers no way to allow Mail for the bot.
        w.spade.say(&w.conversation, "Type in Mail").await?;
        let events = w
            .spade
            .wait_for(&w.conversation, "approval_requested")
            .await?;
        let asked = requests(&events);
        assert_eq!(asked[0]["call_id"], "c2");
        assert_eq!(asked[0]["ask"], "drive");
        assert!(asked[0].get("app").is_none(), "{:?}", asked[0]);
        let line = asked[0]["reviewer_reason"].as_str().unwrap_or_default();
        assert!(line.starts_with("It acts in Mail"), "{line}");
        answer(&w.spade, &w.conversation, "c2", json!({ "allowed": false })).await?;
        w.spade
            .wait_for_count(&w.conversation, "reply_finished", 2)
            .await?;
        // Left to the person in TextEdit, the request offers TextEdit, as ace lists it.
        w.spade.say(&w.conversation, "Click again").await?;
        let events = w
            .spade
            .wait_for_count(&w.conversation, "approval_requested", 2)
            .await?;
        let asked = requests(&events);
        assert_eq!(asked[1]["ask"], "drive");
        assert_eq!(asked[1]["app"], "TextEdit");
        assert_eq!(asked[1]["acts_in"]["id"], "com.apple.TextEdit");
        answer(
            &w.spade,
            &w.conversation,
            "c3",
            json!({ "allowed": true, "always": true }),
        )
        .await?;
        w.spade
            .wait_for_count(&w.conversation, "reply_finished", 3)
            .await?;
        assert_eq!(ran(&acts), 2);
        let (_, grants) = w.spade.get(&format!("/v1/agents/{}/grants", w.bot)).await?;
        let drive_grant = grants.to_string();
        assert!(
            drive_grant.contains(r#""kind":"drive_app""#)
                && drive_grant.contains(r#""app":"com.apple.TextEdit""#),
            "{grants}"
        );
        // The next step there is reviewed as allowed, without asking.
        w.spade.say(&w.conversation, "Once more").await?;
        let events = w
            .spade
            .wait_for_count(&w.conversation, "reply_finished", 4)
            .await?;
        assert_eq!(ran(&acts), 3);
        assert_eq!(requests(&events).len(), 2, "not asked again");
        let reviewed = w.spade.fake.seen();
        let told = reviewed
            .iter()
            .rev()
            .find(|seen| seen.body.to_string().contains("allowed driving TextEdit"));
        assert!(told.is_some(), "the reviewer is told the person allowed it");
        Ok(())
    }

    #[tokio::test]
    async fn a_step_whose_page_changed_after_its_review_does_not_run() -> Result {
        let act = FakeTool::new("browser_act", Risk::Write, r#"{"ok":true}"#)
            .declares(spade_core::effect::Effect::Drive)
            .schema(holds_place());
        let acts = act.calls();
        let page = |url: &str| {
            json!({ "tabs": [
                { "tabId": "t1", "url": url, "title": "", "current": true },
                { "tabId": "t2", "url": "https://docs.rs/serde", "title": "" },
            ] })
            .to_string()
        };
        // Reviewed on docs.rs; by the time it would run, the tab has gone to Gmail.
        let (docs, gmail) = (
            page("https://docs.rs/tokio"),
            page("https://mail.google.com/mail/u/0"),
        );
        let tabs = FakeTool::new("browser_tabs", Risk::Write, "")
            .then_answers(&[docs.as_str(), gmail.as_str()]);
        let w = reviewed_world(false, vec![Arc::new(act), Arc::new(tabs)], |_| {
            vec![
                Script::reply("").call(
                    "c1",
                    "browser_act",
                    json!({ "action": "click", "ref": "e1" }),
                ),
                Script::reply("").plain(APPROVE),
                Script::reply("It moved; I'll look again."),
            ]
        })
        .await?;
        w.spade.say(&w.conversation, "Click the docs link").await?;
        let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
        assert_eq!(ran(&acts), 0, "it never ran on Gmail");
        let told = events
            .iter()
            .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c1")
            .and_then(|e| e["content"].as_str())
            .unwrap_or_default();
        assert!(told.contains("changed since Spade checked"), "{told}");
        assert!(
            requests(&events).is_empty(),
            "reviewed, not asked, on docs.rs"
        );
        Ok(())
    }

    #[tokio::test]
    async fn an_ace_that_cant_hold_a_step_to_its_page_leaves_the_step_to_the_person() -> Result {
        // An ace from before `expect`: its schema doesn't take it.
        let act = FakeTool::new("browser_act", Risk::Write, r#"{"ok":true}"#)
            .declares(spade_core::effect::Effect::Drive);
        let acts = act.calls();
        let listed = json!({ "tabs": [
            { "tabId": "t1", "url": "https://docs.rs/tokio", "title": "", "current": true },
        ] })
        .to_string();
        let tabs = FakeTool::new("browser_tabs", Risk::Write, &listed);
        let w = reviewed_world(false, vec![Arc::new(act), Arc::new(tabs)], |_| {
            vec![
                Script::reply("").call(
                    "c1",
                    "browser_act",
                    json!({ "action": "press", "key": "Enter" }),
                ),
                // Only reached if the reviewer were asked: it would approve.
                Script::reply("").plain(APPROVE),
            ]
        })
        .await?;
        w.spade.say(&w.conversation, "Press Enter").await?;
        let events = w
            .spade
            .wait_for(&w.conversation, "approval_requested")
            .await?;
        let asked = requests(&events);
        let line = asked[0]["reviewer_reason"].as_str().unwrap_or_default();
        assert!(
            line.starts_with("It acts in docs.rs, and this version of ace"),
            "{line}"
        );
        assert!(line.contains("Updating ace"), "{line}");
        assert_eq!(asked[0]["ask"], "drive");
        assert!(
            asked[0].get("app").is_none(),
            "allowing docs.rs wouldn't stop the asking"
        );
        assert_eq!(ran(&acts), 0);
        // Allowed by the person, it runs as they allowed it.
        answer(&w.spade, &w.conversation, "c1", json!({ "allowed": true })).await?;
        until_ran(&acts, 1).await;
        assert_eq!(ran(&acts), 1);
        Ok(())
    }

    #[tokio::test]
    async fn a_step_is_handed_to_ace_bound_to_the_tab_and_address_it_was_checked_at() -> Result {
        // An ace that takes `expect` says so in its schema.
        let act = FakeTool::new("browser_act", Risk::Write, r#"{"ok":true}"#)
            .declares(spade_core::effect::Effect::Drive)
            .schema(json!({ "type": "object", "properties": { "expect": { "type": "object" } } }));
        let acts = act.calls();
        let listed = json!({ "tabs": [
            { "tabId": "t1", "url": "https://docs.rs/tokio", "title": "", "current": true },
        ] })
        .to_string();
        let tabs = FakeTool::new("browser_tabs", Risk::Write, &listed);
        let w = reviewed_world(false, vec![Arc::new(act), Arc::new(tabs)], |_| {
            vec![
                Script::reply("").call(
                    "c1",
                    "browser_act",
                    json!({ "action": "press", "key": "Enter" }),
                ),
                Script::reply("").plain(APPROVE),
                Script::reply("Pressed."),
            ]
        })
        .await?;
        w.spade.say(&w.conversation, "Press Enter").await?;
        w.spade.wait_for(&w.conversation, "reply_finished").await?;
        let sent = acts.lock().map(|calls| calls.clone()).unwrap_or_default();
        assert_eq!(
            sent.first().map(|arguments| arguments["expect"].clone()),
            Some(json!({ "tabId": "t1", "url": "https://docs.rs/tokio" }))
        );
        Ok(())
    }
}

/// A browser step reviewed on docs.rs/tokio, then Spade stopped before it started: on the next
/// start the tab is at `now`. Returns whether it ran and how many reviews it had.
async fn restarted_between_review_and_start(
    now: &str,
    after: Vec<Script>,
) -> Result<(usize, usize)> {
    let listed = |url: &str| {
        json!({ "tabs": [ { "tabId": "t1", "url": url, "title": "", "current": true } ] })
            .to_string()
    };
    let drive = |answer: &str| {
        FakeTool::new("browser_act", Risk::Write, answer)
            .declares(spade_core::effect::Effect::Drive)
            .schema(holds_place())
    };
    let tools = |act: FakeTool, url: &str| {
        vec![
            Arc::new(act) as Arc<dyn Tool>,
            Arc::new(FakeTool::new("browser_tabs", Risk::Write, &listed(url))) as Arc<dyn Tool>,
        ]
    };
    // The reviewer is the scripted model, before and after the restart.
    let reviewed = || support::Options {
        reviewer: None,
        ..support::Options::default()
    };
    let spade = Spade::start_with(
        vec![
            Script::reply("").call(
                "c1",
                "browser_act",
                json!({ "action": "press", "key": "Enter" }),
            ),
            Script::reply("").plain(APPROVE),
            Script::reply("Pressed."),
            Script::reply("").plain(TITLE),
        ],
        tools(drive("{}"), "https://docs.rs/tokio"),
        reviewed(),
    )
    .await?;
    let agent = spade.new_agent("Builder", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Press Enter").await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    // Spade stopped for a restart between the review and the start: the turn paused there.
    let again = drive("{}");
    let pressed = again.calls();
    let spade = spade
        .restart_paused_with(
            "DELETE FROM events WHERE seq > (SELECT seq FROM events
                 WHERE json_extract(body, '$.type') = 'call_reviewed')
               AND conversation_id = (SELECT conversation_id FROM events
                 WHERE json_extract(body, '$.type') = 'call_reviewed');
             INSERT INTO events (conversation_id, seq, at_ms, body)
               SELECT conversation_id, seq + 1, at_ms,
                 json_object('type', 'turn_paused', 'reply', json_extract(body, '$.reply'))
               FROM events WHERE json_extract(body, '$.type') = 'call_reviewed';",
            tools(again, now),
            after,
            reviewed(),
        )
        .await?;
    // It ends, or a refusal waits on the person.
    let events = spade
        .wait_for_any(&conversation, &["reply_finished", "approval_requested"])
        .await?;
    let reviews = events
        .iter()
        .filter(|e| e["type"] == "call_reviewed" && e["call_id"] == "c1")
        .count();
    Ok((ran(&pressed), reviews))
}

#[tokio::test]
async fn a_verdict_given_on_one_page_is_not_reused_on_another_after_a_restart() -> Result {
    const REFUSE: &str = r#"{"verdict":"refuse","reason":"Not that page."}"#;
    let (ran, reviews) = restarted_between_review_and_start(
        "https://docs.rs/serde",
        vec![Script::reply("").plain(REFUSE), Script::reply("Left it.")],
    )
    .await?;
    assert_eq!(
        ran, 0,
        "reviewed again on the new page, and put to the person there"
    );
    assert_eq!(reviews, 2);
    // On the page it was reviewed at, the stored verdict stands: no second review.
    let (ran, reviews) = restarted_between_review_and_start(
        "https://docs.rs/tokio",
        vec![Script::reply("Pressed.")],
    )
    .await?;
    assert_eq!((ran, reviews), (1, 1));
    Ok(())
}

/// A shell command the scripted reviewer allowed, Spade stopped between the review and the start,
/// and `stored` run on the database (to leave the verdict as an earlier review gave it); after
/// the restart the reviewer reads `after`. How many times it ran, and how many reviews it had.
async fn shell_restarted_after_its_review(
    stored: &str,
    after: Vec<Script>,
) -> Result<(usize, usize)> {
    let reviewed = || support::Options {
        reviewer: None,
        ..support::Options::default()
    };
    let shell = || FakeTool::new("shell", Risk::Write, "ok");
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "cargo test" })),
            Script::reply("").plain(APPROVE),
            Script::reply("Tests pass."),
            Script::reply("").plain(TITLE),
        ],
        vec![Arc::new(shell()) as Arc<dyn Tool>],
        reviewed(),
    )
    .await?;
    let agent = spade.new_agent("Builder", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Run the tests").await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    let again = shell();
    let commands = again.calls();
    let spade = spade
        .restart_paused_with(
            &format!(
                "DELETE FROM events WHERE seq > (SELECT seq FROM events
                     WHERE json_extract(body, '$.type') = 'call_reviewed')
                   AND conversation_id = (SELECT conversation_id FROM events
                     WHERE json_extract(body, '$.type') = 'call_reviewed');
                 INSERT INTO events (conversation_id, seq, at_ms, body)
                   SELECT conversation_id, seq + 1, at_ms,
                     json_object('type', 'turn_paused', 'reply', json_extract(body, '$.reply'))
                   FROM events WHERE json_extract(body, '$.type') = 'call_reviewed';
                 {stored}"
            ),
            vec![Arc::new(again) as Arc<dyn Tool>],
            after,
            reviewed(),
        )
        .await?;
    // It ends, or a refusal waits on the person.
    let events = spade
        .wait_for_any(&conversation, &["reply_finished", "approval_requested"])
        .await?;
    let reviews = events
        .iter()
        .filter(|e| e["type"] == "call_reviewed" && e["call_id"] == "c1")
        .count();
    Ok((ran(&commands), reviews))
}

#[tokio::test]
async fn a_reviewer_allow_for_a_contained_command_is_not_reused_once_it_would_run_outside() -> Result
{
    const REFUSE: &str = r#"{"verdict":"refuse","reason":"Not outside the sandbox."}"#;
    let review = "UPDATE events SET body = ";
    // Given while the bot's commands ran in the sandbox, or by a build that recorded no limit
    // (read as contained-only); after the restart the command runs outside it.
    for stored in [
        "json_set(body, '$.launch', 'contained')",
        "json_remove(body, '$.launch')",
    ] {
        let (ran, reviews) = shell_restarted_after_its_review(
            &format!("{review}{stored} WHERE json_extract(body, '$.type') = 'call_reviewed';"),
            vec![Script::reply("").plain(REFUSE), Script::reply("Left it.")],
        )
        .await?;
        assert_eq!(
            ran, 0,
            "reviewed afresh for the wider launch, and put to the person: {stored}"
        );
        assert_eq!(reviews, 2, "{stored}");
    }
    // Given for the launch it now has, the stored verdict stands: no second review.
    let (ran, reviews) =
        shell_restarted_after_its_review("", vec![Script::reply("Tests pass.")]).await?;
    assert_eq!((ran, reviews), (1, 1));
    Ok(())
}

#[tokio::test]
async fn an_approval_stored_without_its_launch_never_lets_a_command_run_outside() -> Result {
    // Asked by a build that recorded no launch with it, for a command run outside the sandbox,
    // whether the bot asked for that or its commands ran there: read as contained-only.
    for arguments in [
        json!({ "command": "cargo test", "outside_sandbox": true }),
        json!({ "command": "cargo test" }),
    ] {
        let spade = Spade::start(
            vec![Script::reply("").call("c1", "shell", arguments.clone())],
            vec![Arc::new(FakeTool::new("shell", Risk::Write, "ok")) as Arc<dyn Tool>],
        )
        .await?;
        let agent = spade.new_agent("Builder", "").await?;
        let conversation = agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        spade.say(&conversation, "Run the tests").await?;
        spade.wait_for(&conversation, "approval_requested").await?;
        let again = FakeTool::new("shell", Risk::Write, "ok");
        let commands = again.calls();
        let spade = spade
            .restart_paused_with(
                "UPDATE events SET body = json_remove(body, '$.launch')
                   WHERE json_extract(body, '$.type') = 'approval_requested';",
                vec![Arc::new(again) as Arc<dyn Tool>],
                vec![Script::reply("Left it."), Script::reply("").plain(TITLE)],
                support::Options::default(),
            )
            .await?;
        let (status, body) = spade
            .post(
                &format!("/v1/conversations/{conversation}/approvals/c1"),
                json!({ "allowed": true }),
            )
            .await?;
        assert_eq!(status, 202, "{body}");
        let events = spade.wait_for(&conversation, "reply_finished").await?;
        let said = events
            .iter()
            .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c1")
            .map(|e| e["content"].to_string())
            .unwrap_or_default();
        assert!(
            said.contains("wider than when the person allowed it"),
            "{arguments}: {said}"
        );
        assert_eq!(ran(&commands), 0, "{arguments}");
    }
    Ok(())
}

/// A conversation holding the person's Always allow from an earlier call, `asked` as it was
/// stored, then `tool` called with `cargo test`: how many times it ran, and whether it asked.
async fn cargo_test_after_an_always_allow(asked: Value, tool: FakeTool) -> Result<(usize, bool)> {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let agent = spade.new_agent("Builder", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let stored = |body: Value| {
        format!(
            "INSERT INTO events (conversation_id, seq, at_ms, body) SELECT '{conversation}', \
             COALESCE(MAX(seq), 0) + 1, 0, '{body}' FROM events \
             WHERE conversation_id = '{conversation}';"
        )
    };
    let call = asked["call_id"].clone();
    let seed = [
        stored(asked),
        stored(
            json!({ "type": "approval_answered", "reply": "r0", "call_id": call,
                       "allowed": true, "always": true }),
        ),
    ]
    .join("\n");
    let commands = tool.calls();
    let spade = spade
        .restart_paused_with(
            &seed,
            vec![Arc::new(tool) as Arc<dyn Tool>],
            vec![
                Script::reply("").call("c1", "shell", json!({ "command": "cargo test" })),
                Script::reply("Tests pass."),
                Script::reply("").plain(TITLE),
            ],
            support::Options::default(),
        )
        .await?;
    spade.say(&conversation, "Run the tests").await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let events = spade.events(&conversation).await?;
        let asked = requests(&events).iter().any(|e| e["call_id"] == "c1");
        let done = events.iter().any(|e| e["type"] == "reply_finished");
        if asked || done || Instant::now() > deadline {
            return Ok((ran(&commands), asked));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn an_always_allow_given_for_a_contained_command_is_not_reused_to_run_it_outside() -> Result {
    // The fake shell's commands run outside the sandbox. An Always allow for `cargo test` given
    // while they ran in it, and one for the whole tool from a build that recorded no launch (read
    // as contained-only), each leave the command to be asked about afresh.
    let given = |scope: Option<&str>, launch: Option<&str>| {
        let mut asked = json!({ "type": "approval_requested", "reply": "r0", "call_id": "old",
                               "name": "shell", "arguments": { "command": "cargo test" } });
        if let Some(scope) = scope {
            asked["scope"] = json!(scope);
        }
        if let Some(launch) = launch {
            asked["launch"] = json!(launch);
        }
        asked
    };
    let scoped = || FakeTool::new("shell", Risk::Write, "ok").scoped();
    let whole = || FakeTool::new("shell", Risk::Write, "ok");
    for (asked, tool) in [
        (given(Some("cargo test"), Some("contained")), scoped()),
        (given(Some("cargo test"), None), scoped()),
        (given(None, None), whole()),
    ] {
        let (ran, asked_again) = cargo_test_after_an_always_allow(asked.clone(), tool).await?;
        assert_eq!((ran, asked_again), (0, true), "{asked}");
    }
    // Given for a launch outside, the scoped Always allow still holds there.
    let (ran, asked_again) =
        cargo_test_after_an_always_allow(given(Some("cargo test"), Some("outside")), scoped())
            .await?;
    assert_eq!((ran, asked_again), (1, false));
    Ok(())
}

#[tokio::test]
async fn an_always_allow_an_earlier_build_stored_for_sim_act_never_skips_the_person() -> Result {
    let tool = || {
        FakeTool::new("sim_act", Risk::Write, "{}")
            .declares(spade_core::effect::Effect::Drive)
            .schema(holds_place())
    };
    let spade = Spade::start(Vec::new(), vec![Arc::new(tool()) as Arc<dyn Tool>]).await?;
    let agent = spade.new_agent("Builder", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // An earlier build asked about sim_act with no reason of Spade's, and the person answered
    // Always allow: the conversation holds an Always allow for the tool.
    let stored = |seq: u32, body: Value| {
        format!(
            "INSERT INTO events (conversation_id, seq, at_ms, body) SELECT '{conversation}', \
             COALESCE(MAX(seq), 0) + {seq}, 0, '{body}' FROM events \
             WHERE conversation_id = '{conversation}';"
        )
    };
    let seed = [
        stored(
            1,
            json!({ "type": "approval_requested", "reply": "r0", "call_id": "old",
                    "name": "sim_act", "arguments": {} }),
        ),
        stored(
            1,
            json!({ "type": "approval_answered", "reply": "r0", "call_id": "old",
                    "allowed": true, "always": true }),
        ),
    ]
    .join("\n");
    let act = tool();
    let opened = act.calls();
    let spade = spade
        .restart_paused_with(
            &seed,
            vec![Arc::new(act) as Arc<dyn Tool>],
            vec![Script::reply("").call(
                "c1",
                "sim_act",
                json!({ "simId": "s1", "action": "open_app", "appId": "com.apple.calculator" }),
            )],
            support::Options::default(),
        )
        .await?;
    spade.say(&conversation, "Open the calculator").await?;
    let events = spade
        .wait_for_count(&conversation, "approval_requested", 2)
        .await?;
    let asked = requests(&events);
    let last = asked.last().map(|each| each.to_owned()).unwrap_or_default();
    assert_eq!(last["call_id"], "c1");
    assert_eq!(last["ask"], "drive");
    let line = last["reviewer_reason"].as_str().unwrap_or_default();
    assert!(line.contains("a simulator or device"), "{line}");
    assert!(
        last.get("app").is_none(),
        "a device is never allowed for the bot"
    );
    assert_eq!(ran(&opened), 0);
    Ok(())
}
