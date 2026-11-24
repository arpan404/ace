//! What the default bot is offered before anyone says anything (spade/docs/harness.md, Tools).
//! Run with `--nocapture` for the per-tool table:
//!
//! ```sh
//! cargo test -p spade-server tool_tokens -- --nocapture
//! ```

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use spade_fetch::{Fetcher, Policy};
use spade_models::ToolSpec;
use spade_search::{Cloud, Search};
use spade_server::clock::SystemClock;
use spade_server::computer::Terminals;
use spade_server::learning::Learning;
use spade_server::services::Services;
use spade_server::skill_store::SkillStore;
use spade_server::tools::outward::{SandboxStage, SystemHost};
use spade_server::tools::{CloudAccount, EngineHandle, Own, SkillLibrary, Toolbox, own_tools};
use spade_server::workspace::Workspaces;
use spade_server::workspace::shell::Shell;
use spade_store::Store;
use spade_testkit::Script;
use support::{Options, Result, Spade};

/// A token budget for the fixed prompt's tool list. It is paid on every model call of every bot,
/// so a change that grows it needs a reason (docs/harness.md, Tools).
const BUDGET: usize = 6_500;

/// The tools a bot needs constantly: every one of them is offered to the default bot
/// (spade/docs/harness.md, Tools).
const CORE: [&str; 15] = [
    "ask_user",
    "asks",
    "call_tool",
    "helper",
    "memory_save",
    "memory_search",
    "profile_update",
    "python",
    "shell",
    "task_status",
    "tool_search",
    "web_fetch",
    "web_search",
    "workspace_read",
    "workspace_write",
];

fn default_toolbox() -> Result<(Toolbox, tempfile::TempDir)> {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path().join("workspace"));
    let bots = EngineHandle::default();
    let shell = Shell::system();
    let terminals = Terminals::new(
        dir.path().join("terminal"),
        workspaces.clone(),
        shell.clone(),
        Arc::new(SystemClock),
    );
    let services = Services::new(workspaces.clone(), shell.clone(), bots.clone());
    let library: Arc<dyn SkillLibrary> = SkillStore::open(
        dir.path().join("skills"),
        Store::open(&dir.path().join("spade.sqlite"))?,
        Arc::new(SystemClock),
        None,
    );
    let learning = Arc::new(Learning::new(
        dir.path().join("skills"),
        Arc::new(SystemClock),
        library.clone(),
    ));
    let search = Arc::new(Search::new(Cloud {
        url: None,
        credential: Arc::new(CloudAccount::new(None)),
        ace_client: None,
        timeout: Duration::from_secs(1),
        clock: Arc::new(std::time::Instant::now),
    })?);
    let core = own_tools(Own {
        search,
        fetcher: Arc::new(Fetcher::new(Policy::default(), Duration::from_secs(1))),
        workspaces: workspaces.clone(),
        bots: bots.clone(),
        commands: spade_server::computer::shell_commands(&terminals, shell.clone()),
        services,
        outward_scratch: dir.path().join("outward"),
        host: Arc::new(SystemHost),
        stage: Arc::new(SandboxStage::new(shell)),
        library,
        learning,
    });
    // As Spade starts: a source that offers nothing until a model can make images, which is
    // enough for `tool_search` and `call_tool` to be offered.
    let toolbox = Toolbox::new(core).with_source(spade_server::media::tools::images(&bots));
    Ok((spade_server::tools::with_engine_tools(toolbox, &bots), dir))
}

/// The tools of one request, as the model was sent them.
fn offered(body: &Value) -> Vec<ToolSpec> {
    body["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .map(|tool| ToolSpec {
                    name: tool["function"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    description: tool["function"]["description"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    schema: tool["function"]["parameters"].clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn the_default_bots_offered_tools_hold_their_core_set_and_their_token_budget() -> Result<()> {
    let (toolbox, _dir) = default_toolbox()?;
    let spade = Spade::start_toolbox(
        vec![
            Script::reply("Ready."),
            Script::reply("").plain(r#"{"title":"Hello"}"#),
        ],
        toolbox,
        Options::default(),
    )
    .await?;
    let id = spade.ask("Hello").await?;
    spade.wait_for(&id, "reply_finished").await?;

    // The real offer path: the first model call's own request, stored as the conversation's list.
    let body = spade
        .fake
        .seen()
        .into_iter()
        .next()
        .map(|seen| seen.body)
        .ok_or("the bot made no request")?;
    let specs = offered(&body);
    let names: Vec<&str> = specs.iter().map(|spec| spec.name.as_str()).collect();
    for name in CORE {
        assert!(names.contains(&name), "{name} is offered: {names:?}");
    }

    let (rows, total) = spade_core::tools::sizes(&specs);
    println!("{}", spade_core::tools::size_report(&specs));
    assert!(
        total.tokens <= BUDGET,
        "the fixed prompt's tool list is {} tokens ({} characters) over {} tools, past its \
         {BUDGET}-token budget; shorten a description or defer a tool (docs/harness.md, Tools)",
        total.tokens,
        total.chars,
        rows.len()
    );
    Ok(())
}
