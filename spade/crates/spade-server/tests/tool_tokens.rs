//! What the default bot's tool list costs before anyone says anything (spade/docs/harness.md,
//! Tools). Run with `--nocapture` for the per-tool table:
//!
//! ```sh
//! cargo test -p spade-server tool_tokens -- --nocapture
//! ```

use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use spade_fetch::{Fetcher, Policy};
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

/// A token budget for the fixed prompt's tool list. It is paid on every model call of every bot,
/// so a change that grows it needs a reason (docs/harness.md, Tools).
const BUDGET: usize = 6_200;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn default_toolbox() -> Result<Toolbox> {
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
    Ok(spade_server::tools::with_engine_tools(toolbox, &bots))
}

#[test]
fn the_default_bots_tool_list_stays_within_its_token_budget() -> Result<()> {
    let offered = default_toolbox()?.registry().offered();
    let (rows, total) = spade_core::tools::sizes(&offered);
    println!("{}", spade_core::tools::size_report(&offered));
    assert!(
        rows.iter().any(|row| row.name == "web_search"),
        "the default bot is offered Spade's own tools: {:?}",
        rows.iter().map(|row| &row.name).collect::<Vec<_>>()
    );
    assert!(
        rows.iter().any(|row| row.name == "call_tool"),
        "deferred tools are always findable, so call_tool is offered"
    );
    assert!(
        total.tokens <= BUDGET,
        "the fixed prompt's tool list is {} tokens ({} characters), over its {BUDGET}-token \
         budget; shorten a description or defer a tool (docs/harness.md, Tools)",
        total.tokens,
        total.chars
    );
    Ok(())
}
