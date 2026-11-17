//! A server whose bots' commands run through the machine's sandbox (ADR 0167), a fake home folder
//! holding the person's files, and one bot: the world the security and effects process tests
//! share.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde_json::{Value, json};
use spade_server::clock::{CountingIds, SystemClock};
use spade_server::security::{Security, Setup};
use spade_server::tools::{EngineHandle, Tool};
use spade_server::workspace::shell::{Confine, Confinement, Kind, Shell};
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_store::Store;
use spade_testkit::Script;

use super::{Result, Spade};

/// The security service, set once the server (and its database) exists.
#[derive(Default)]
pub struct Late(OnceLock<Arc<Security>>);

impl Confine for Late {
    fn confine(&self, home: &Path, kind: &Kind) -> std::result::Result<Confinement, String> {
        match self.0.get() {
            Some(security) => security.confine(home, kind),
            None => Err("the security service isn't set".to_owned()),
        }
    }

    fn contains(&self, home: &Path) -> bool {
        self.0
            .get()
            .is_some_and(|security| Confine::contains(security.as_ref(), home))
    }

    fn outside(&self, home: &Path) -> bool {
        self.0
            .get()
            .is_some_and(|security| Confine::outside(security.as_ref(), home))
    }

    fn before(
        &self,
        home: &Path,
        kind: &Kind,
    ) -> Option<Box<dyn FnOnce() -> std::result::Result<(), String> + Send>> {
        self.0.get()?.before(home, kind)
    }
}

pub struct World {
    pub spade: Spade,
    pub security: Arc<Security>,
    pub _dir: tempfile::TempDir,
    pub home: PathBuf,
    pub conversation: String,
    pub bot: String,
    /// The bots' shell, confined by the world's security service.
    pub shell: Shell,
    /// Where the bots' workspaces are.
    pub workspaces: Workspaces,
    /// The engine, for tools a test builds itself.
    pub bots: EngineHandle,
}

/// Where a world's files are, for the scripts that name them.
pub struct Places {
    pub root: PathBuf,
    pub home: PathBuf,
}

/// A server whose bots' shell runs through the sandbox (or with `sandboxed: false`, none), a fake
/// home folder holding the person's files, and one bot running `scripts`.
pub async fn world(
    sandboxed: bool,
    extra: Vec<Arc<dyn Tool>>,
    scripts: impl FnOnce(&Places) -> Vec<Script>,
) -> Result<World> {
    world_in(false, sandboxed, extra, scripts).await
}

/// [`world`], its commands run in the bot's terminal (as Spade runs them on macOS) when
/// `terminal`.
pub async fn world_in(
    terminal: bool,
    sandboxed: bool,
    extra: Vec<Arc<dyn Tool>>,
    scripts: impl FnOnce(&Places) -> Vec<Script>,
) -> Result<World> {
    world_with(
        super::Options::default(),
        terminal,
        sandboxed,
        extra,
        scripts,
    )
    .await
}

/// [`world`] whose reviewer is the scripted fake model, so a review reads the next script.
pub async fn reviewed_world(
    sandboxed: bool,
    extra: Vec<Arc<dyn Tool>>,
    scripts: impl FnOnce(&Places) -> Vec<Script>,
) -> Result<World> {
    let options = super::Options {
        reviewer: None,
        ..super::Options::default()
    };
    world_with(options, false, sandboxed, extra, scripts).await
}

/// [`world`] (sandboxed) whose bots' shell goes through `wrap` around the security service, so a
/// test can change what the sandbox holds between the gate's decision and the launch.
pub async fn wrapped_world(
    wrap: impl FnOnce(Arc<dyn Confine>) -> Arc<dyn Confine>,
    scripts: impl FnOnce(&Places) -> Vec<Script>,
) -> Result<World> {
    world_built(
        super::Options::default(),
        false,
        true,
        vec![],
        scripts,
        wrap,
    )
    .await
}

async fn world_with(
    options: super::Options,
    terminal: bool,
    sandboxed: bool,
    extra: Vec<Arc<dyn Tool>>,
    scripts: impl FnOnce(&Places) -> Vec<Script>,
) -> Result<World> {
    world_built(options, terminal, sandboxed, extra, scripts, |late| late).await
}

async fn world_built(
    options: super::Options,
    terminal: bool,
    sandboxed: bool,
    extra: Vec<Arc<dyn Tool>>,
    scripts: impl FnOnce(&Places) -> Vec<Script>,
    wrap: impl FnOnce(Arc<dyn Confine>) -> Arc<dyn Confine>,
) -> Result<World> {
    let dir = tempfile::tempdir()?;
    let root = std::fs::canonicalize(dir.path())?;
    let home = root.join("home");
    let data = root.join("data");
    std::fs::create_dir_all(home.join("Documents"))?;
    std::fs::create_dir_all(home.join("code/app"))?;
    std::fs::write(home.join("Documents/tax.txt"), "TAX-SECRET")?;
    let workspaces = Workspaces::new(data.join("workspace"));
    let late = Arc::new(Late::default());
    let bots = EngineHandle::default();
    let shell = Shell::system().confined(wrap(late.clone()));
    let kept = (shell.clone(), workspaces.clone(), bots.clone());
    let commands = if terminal {
        let terminals = spade_server::computer::Terminals::new(
            data.join("terminal"),
            workspaces.clone(),
            shell.clone(),
            Arc::new(SystemClock),
        );
        spade_server::computer::shell_commands(&terminals, shell)
    } else {
        shell.into()
    };
    let mut tools: Vec<Arc<dyn Tool>> = workspace_tools(workspaces.clone(), bots.clone(), commands);
    tools.extend(extra);
    let scripts = scripts(&Places {
        root: root.clone(),
        home: home.clone(),
    });
    let spade = Spade::start_with(scripts, tools, options).await?;
    bots.set(&spade.engine);
    let runner = if sandboxed {
        // Linux starts Spade's own binary as the launcher; macOS's sandbox needs none.
        spade_sandbox::Runner::probe(Some(PathBuf::from(env!("CARGO_BIN_EXE_spade"))))
    } else {
        spade_sandbox::Runner::unavailable("no sandbox in this test")
    };
    let security = Security::start(Setup {
        runner,
        store: Store::open(&spade.database())?,
        home: home.clone(),
        spade_data: data.clone(),
        ace_data: None,
        workspaces: data.join("workspace"),
        log_dir: data.join("egress"),
        clock: Arc::new(SystemClock),
        ids: Arc::new(CountingIds::default()),
        bots,
    })
    .await;
    let _ = late.0.set(security.clone());
    spade.engine.set_security(security.clone());
    let agent = spade.new_agent("Builder", "").await?;
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    Ok(World {
        bot: field("id"),
        conversation: field("conversation"),
        spade,
        security,
        _dir: dir,
        home,
        shell: kept.0,
        workspaces: kept.1,
        bots: kept.2,
    })
}

pub fn quoted(path: &Path) -> String {
    format!("'{}'", path.display())
}

pub fn asked(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .map(|e| e["call_id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

pub fn output<'a>(events: &'a [Value], call: &str) -> &'a str {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default()
}

pub fn shell(id: &str, command: String) -> Script {
    Script::reply("").call(id, "shell", json!({ "command": command }))
}
