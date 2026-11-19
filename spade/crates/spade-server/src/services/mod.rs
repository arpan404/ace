//! The processes of bots' owned services (ADR 0160): each runs through the workspace shell
//! (built environment without Spade's secrets, system-only `PATH`, its own process group or job
//! object), for as long as it runs, outliving the turn and the call that started it. Aborting
//! its run ends it with everything it started. What it prints goes to a bounded ring of lines
//! and to the engine, which wakes the bots waiting on it. Which services exist, and how they
//! ended, is in the bot's events; this only holds the live processes.

mod log;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use log::{LOG_BYTES, Line, Log};

use crate::tools::EngineHandle;
use crate::workspace::Workspaces;
use crate::workspace::shell::{Job, Shell, Tee};

/// A service's deadline: none that matters.
const FOREVER: Duration = Duration::from_secs(100 * 365 * 24 * 60 * 60);

/// What a service needs to start.
pub struct Launch {
    pub conversation: String,
    pub bot: String,
    pub service: String,
    pub name: String,
    pub command: String,
    /// Relative to the workspace; empty for the workspace itself.
    pub cwd: String,
    /// What the gate authorized (ADR 0171): a service it let start because the sandbox holds it
    /// starts only held, and is refused where nothing does.
    pub decided: crate::workspace::shell::Launch,
}

struct Running {
    conversation: String,
    name: String,
    log: Arc<Mutex<Log>>,
    task: tokio::task::AbortHandle,
}

/// The live services of every bot.
pub struct Services {
    workspaces: Workspaces,
    shell: Shell,
    bots: EngineHandle,
    running: Mutex<HashMap<String, Running>>,
    /// Logs of services that ended, kept until the name starts again.
    ended: Mutex<HashMap<String, Arc<Mutex<Log>>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Services {
    /// Services in `workspaces`, run with `shell`, telling the engine `bots` names once set.
    pub fn new(workspaces: Workspaces, shell: Shell, bots: EngineHandle) -> Arc<Self> {
        Arc::new(Self {
            workspaces,
            shell,
            bots,
            running: Mutex::default(),
            ended: Mutex::default(),
        })
    }

    /// The engine, once it exists.
    pub(crate) fn engine(&self) -> Option<Arc<crate::engine::Engine>> {
        self.bots.get()
    }

    pub fn workspaces(&self) -> &Workspaces {
        &self.workspaces
    }

    /// The folder `cwd` names in `bot`'s workspace, which must exist.
    pub fn folder(&self, bot: &str, cwd: &str) -> Result<(PathBuf, PathBuf), String> {
        let workspace = self.workspaces.of(bot).map_err(|e| e.to_string())?;
        let root = workspace.path().map_err(|e| e.to_string())?;
        let dir = if cwd.trim().is_empty() || cwd.trim() == "." {
            root.clone()
        } else {
            root.join(workspace.normal(cwd).map_err(|e| e.to_string())?)
        };
        if !dir.is_dir() {
            return Err(format!("{cwd} is not a folder in your workspace"));
        }
        Ok((root, dir))
    }

    /// Starts `launch`. Its end (by itself) is reported to the engine; a stop is not.
    pub fn start(self: &Arc<Self>, launch: Launch) -> Result<(), String> {
        let (home, dir) = self.folder(&launch.bot, &launch.cwd)?;
        // Decided once at the gate, never again here. A service never leaves the sandbox: the
        // gate's "outside" for one only means its command was classed for the review.
        let decided = match launch.decided {
            crate::workspace::shell::Launch::Outside => crate::workspace::shell::Launch::Reviewed,
            decided => decided,
        };
        let plan = decided.plan(self.shell.contains(&home))?;
        let log = Arc::new(Mutex::new(Log::default()));
        let tee: Tee = {
            let (log, bots) = (log.clone(), self.bots.clone());
            let (conversation, service, name) = (
                launch.conversation.clone(),
                launch.service.clone(),
                launch.name.clone(),
            );
            Arc::new(move |bytes: &[u8]| {
                let lines = lock(&log).push(bytes);
                if lines.is_empty() {
                    return;
                }
                if let Some(engine) = bots.get() {
                    for line in lines {
                        engine.wake_on_service_line(&conversation, &service, &name, &line);
                    }
                }
            })
        };
        let mut running = lock(&self.running);
        if running.contains_key(&launch.service) {
            return Err(format!("{} is already running", launch.name));
        }
        let task = {
            let (services, shell) = (self.clone(), self.shell.clone());
            let (service, command) = (launch.service.clone(), launch.command.clone());
            let (conversation, log) = (launch.conversation.clone(), log.clone());
            tokio::spawn(async move {
                let ran = shell
                    .run_from(
                        &home,
                        Job {
                            dir: &dir,
                            script: &command,
                            timeout: FOREVER,
                            env: &[],
                            tee: Some(tee),
                            cleanup: None,
                            stdin: None,
                            kind: crate::workspace::shell::Kind::Command,
                            outside: plan.outside,
                            // An owned service must be contained wherever it can be; one the gate
                            // let start only held is refused where nothing holds it.
                            may_run_uncontained: false,
                            contained_only: plan.contained_only(),
                            verify: None,
                            clean: false,
                            read_only: false,
                        },
                    )
                    .await;
                // Gone from the map means it was stopped, and whoever stopped it says so.
                let Some(gone) = lock(&services.running).remove(&service) else {
                    return;
                };
                lock(&log).finish();
                lock(&services.ended).insert(service.clone(), gone.log.clone());
                let code = ran.as_ref().ok().and_then(|r| r.code);
                let failed = ran.err();
                if let Some(engine) = services.bots.get() {
                    engine.service_exited(&conversation, &service, code, failed);
                }
            })
        };
        running.insert(
            launch.service.clone(),
            Running {
                conversation: launch.conversation,
                name: launch.name,
                log,
                task: task.abort_handle(),
            },
        );
        lock(&self.ended).remove(&launch.service);
        Ok(())
    }

    /// Stops `service` with everything it started; whether it was running.
    pub fn stop(&self, service: &str) -> bool {
        let Some(gone) = lock(&self.running).remove(service) else {
            return false;
        };
        // Dropping the run ends its process group (or closes its job object) at once.
        gone.task.abort();
        lock(&gone.log).finish();
        lock(&self.ended).insert(service.to_owned(), gone.log);
        true
    }

    /// Stops every service of `conversation`; their ids.
    pub fn stop_all_of(&self, conversation: &str) -> Vec<String> {
        let ids: Vec<String> = lock(&self.running)
            .iter()
            .filter(|(_, r)| r.conversation == conversation)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter().filter(|id| self.stop(id)).collect()
    }

    /// Stops every service, as Spade closes. Nothing is recorded: a `keep` one starts again.
    pub fn stop_everything(&self) {
        let all: Vec<Running> = lock(&self.running).drain().map(|(_, r)| r).collect();
        for gone in all {
            gone.task.abort();
        }
    }

    /// How many services of `conversation` run now.
    pub fn running_of(&self, conversation: &str) -> usize {
        lock(&self.running)
            .values()
            .filter(|r| r.conversation == conversation)
            .count()
    }

    pub fn is_running(&self, service: &str) -> bool {
        lock(&self.running).contains_key(service)
    }

    /// The name of running `service`.
    pub fn name_of(&self, service: &str) -> Option<String> {
        lock(&self.running).get(service).map(|r| r.name.clone())
    }

    /// The last `most` lines of `service`'s output after line `after` (0 for all kept), and the
    /// number of the next line it will print.
    pub fn lines(&self, service: &str, after: u64, most: usize) -> Option<(Vec<Line>, u64)> {
        let log = lock(&self.running)
            .get(service)
            .map(|r| r.log.clone())
            .or_else(|| lock(&self.ended).get(service).cloned())?;
        let log = lock(&log);
        Some((log.tail(after, most), log.next()))
    }
}
