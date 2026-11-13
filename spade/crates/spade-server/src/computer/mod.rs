//! A bot's computer (ADR 0142, docs/computer.md): its surfaces (`browser` and `screen` through
//! ace, `terminal` and `files` here), who drives it (`bot` or `person`), and what the person did
//! while they drove, for the note the bot reads when they hand it back.
//!
//! Who drives is kept in `<data folder>/computer/<bot id>.json` while the person does, so a
//! restart keeps the bot paused. Surfaces are what is happening now and live in memory.

mod ace_sync;
pub mod daemon;
pub mod note;
pub mod plain;
pub mod ring;
#[cfg(unix)]
pub mod terminal;
#[cfg(not(unix))]
#[path = "terminal_none.rs"]
pub mod terminal;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::clock::Clock;
use crate::workspace::{Snapshot, Workspaces, changes};
pub use ace_sync::RESYNC;
pub use terminal::Terminals;

/// Where the bots' `shell` commands run here: in each bot's terminal, or (Windows, which has no
/// bot terminal yet) each on its own.
pub fn shell_commands(
    terminals: &Arc<Terminals>,
    shell: crate::workspace::shell::Shell,
) -> crate::workspace::Commands {
    if cfg!(unix) {
        crate::workspace::Commands::Terminal(terminals.clone())
    } else {
        crate::workspace::Commands::OneShot(shell)
    }
}

/// How long a surface counts as live after it was last used.
pub const ACTIVE: Duration = Duration::from_secs(2 * 60);
/// Most lines the person entered that a hand-back note keeps.
const MOST_COMMANDS: usize = plain::MOST_LINES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Driver {
    #[default]
    Bot,
    Person,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Browser,
    Screen,
    Terminal,
    Files,
}

#[cfg(test)]
mod tests {
    use super::Kind;

    #[test]
    fn simulator_and_screen_tools_drive_the_screen_and_browser_tools_the_browser() {
        assert_eq!(Kind::of_tool("sim_tap"), Some(Kind::Screen));
        assert_eq!(Kind::of_tool("screen_act"), Some(Kind::Screen));
        assert_eq!(Kind::of_tool("browser_open"), Some(Kind::Browser));
        assert_eq!(Kind::of_tool("thread_start"), None);
    }
}

impl Kind {
    /// The surface ace's tool `name` drives, if any.
    pub fn of_tool(name: &str) -> Option<Self> {
        if name.starts_with("browser_") {
            Some(Self::Browser)
        } else if name.starts_with("screen_") || name.starts_with("sim_") {
            Some(Self::Screen)
        } else {
            None
        }
    }

    fn word(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Screen => "screen",
            Self::Terminal => "terminal",
            Self::Files => "files",
        }
    }
}

/// What `GET /v1/agents/{id}/computer` answers and the live `computer` frame carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct View {
    pub driver: Driver,
    /// The hidden ace thread the bot's browser and screen run in, as ace reported it, so the app
    /// can watch them.
    pub thread_id: Option<String>,
    pub surfaces: Vec<SurfaceView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SurfaceView {
    pub kind: Kind,
    pub live: bool,
    pub title: Option<String>,
    /// When it became live.
    pub since: Option<i64>,
    /// The page, for a browser ace reported one for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The browser tab, as ace reported it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// `user` when the tab is in the person's own browser, which ace doesn't stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// When it was last used.
    pub last: Option<i64>,
}

/// A change the app hears on the conversation's live stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Computer {
        agent: String,
        view: View,
    },
    /// Files changed in the agent's workspace; `None` when Spade can't say which (a command ran).
    Files {
        agent: String,
        paths: Option<Vec<String>>,
    },
}

impl Change {
    pub fn agent(&self) -> &str {
        match self {
            Self::Computer { agent, .. } | Self::Files { agent, .. } => agent,
        }
    }
}

/// What ace reports about a bot's browser or screen.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Report {
    pub live: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// The person clicked or typed in it (while they had the computer).
    #[serde(default)]
    pub person_acted: bool,
    /// The hidden ace thread the bot's browser and screen run in.
    #[serde(default)]
    pub thread_id: Option<String>,
    /// The browser tab.
    #[serde(default)]
    pub tab_id: Option<String>,
    /// `user` for a tab in the person's own browser.
    #[serde(default)]
    pub backend: Option<String>,
}

/// A person's turn at the computer, kept on disk while it lasts.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Record {
    conversation: String,
    since: i64,
    /// The workspace when they took over.
    snapshot: Snapshot,
    commands: Vec<String>,
    #[serde(default)]
    more_commands: usize,
    /// Surfaces ace said they used.
    #[serde(default)]
    used: BTreeSet<String>,
    /// Paths they wrote through the app.
    #[serde(default)]
    wrote: BTreeSet<String>,
}

/// A browser or screen, as reported and as the bot used it.
#[derive(Debug, Clone, Default)]
struct Surface {
    reported_live: bool,
    title: Option<String>,
    url: Option<String>,
    tab_id: Option<String>,
    backend: Option<String>,
    since: Option<i64>,
    last: Option<i64>,
}

#[derive(Debug, Clone, Default)]
struct Touched {
    path: Option<String>,
    at: i64,
}

/// Every bot's computer.
pub struct Computers {
    root: PathBuf,
    workspaces: Workspaces,
    terminals: Arc<Terminals>,
    clock: Arc<dyn Clock>,
    records: Mutex<HashMap<String, Record>>,
    surfaces: Mutex<HashMap<(String, Kind), Surface>>,
    files: Mutex<HashMap<String, Touched>>,
    /// Each bot's ace thread, as ace last reported it.
    threads: Mutex<HashMap<String, String>>,
    /// The last view sent for each bot, so only changes are sent.
    sent: Mutex<HashMap<String, View>>,
    /// Bots with a task waiting to send their surfaces going quiet.
    watched: Mutex<HashSet<String>>,
    /// ace's daemon, for the browser and screen (`ace_sync`).
    daemon: std::sync::OnceLock<Arc<dyn daemon::Daemon>>,
    /// Bots handed back whose release ace hasn't confirmed yet.
    releasing: Mutex<HashSet<String>>,
    /// Bots whose browser and screen haven't been read from ace since Spade started.
    unread: Mutex<HashSet<String>>,
    changes: broadcast::Sender<Change>,
    me: Weak<Self>,
}

#[derive(Debug, thiserror::Error)]
pub enum ComputerError {
    #[error("{0}")]
    Io(String),
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Computers {
    /// Opens the records under `root` (`<data folder>/computer`): a bot the person had when
    /// Spade stopped is still theirs.
    pub fn open(
        root: impl Into<PathBuf>,
        workspaces: Workspaces,
        terminals: Arc<Terminals>,
        clock: Arc<dyn Clock>,
    ) -> Arc<Self> {
        let root = root.into();
        let mut records = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                let Some(bot) = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.strip_suffix(".json"))
                    .map(str::to_owned)
                else {
                    continue;
                };
                let record = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| serde_json::from_str::<Record>(&text).ok());
                match record {
                    Some(record) => {
                        records.insert(bot, record);
                    }
                    // Unreadable, it still says the person drives: the bot stays paused rather
                    // than acting while the person may be at its computer.
                    None => {
                        tracing::warn!(%bot, "a computer record could not be read; the person keeps it");
                        records.insert(bot, Record::default());
                    }
                }
            }
        }
        let computers = Arc::new_cyclic(|me| Self {
            root,
            workspaces,
            terminals: terminals.clone(),
            clock,
            records: Mutex::new(records),
            surfaces: Mutex::default(),
            files: Mutex::default(),
            threads: Mutex::default(),
            sent: Mutex::default(),
            watched: Mutex::default(),
            daemon: std::sync::OnceLock::new(),
            releasing: Mutex::default(),
            unread: Mutex::default(),
            changes: broadcast::channel(1024).0,
            me: me.clone(),
        });
        let me = Arc::downgrade(&computers);
        terminals.on_change(Arc::new(move |bot| {
            if let Some(computers) = me.upgrade() {
                computers.changed(bot);
            }
        }));
        computers
    }

    /// Ends terminals unused for `idle` (not those of bots the person has), checking every few
    /// minutes while Spade runs.
    pub fn reap_idle(self: &Arc<Self>, idle: Duration) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5 * 60)).await;
                let Some(computers) = me.upgrade() else {
                    return;
                };
                let held = computers.held();
                let ended = computers
                    .terminals
                    .reap(idle, |bot| held.iter().any(|h| h == bot));
                if ended > 0 {
                    tracing::info!(ended, "ended idle bot terminals");
                }
            }
        });
    }

    pub fn terminals(&self) -> &Arc<Terminals> {
        &self.terminals
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Change> {
        self.changes.subscribe()
    }

    pub fn driver(&self, agent: &str) -> Driver {
        if lock(&self.records).contains_key(agent) {
            Driver::Person
        } else {
            Driver::Bot
        }
    }

    /// Whether the person has any bot's computer, so a check by bot can be skipped.
    pub fn holds_any(&self) -> bool {
        !lock(&self.records).is_empty()
    }

    /// Bots the person has, for the terminal reaper.
    pub fn held(&self) -> Vec<String> {
        lock(&self.records).keys().cloned().collect()
    }

    /// The bot's computer now.
    pub fn view(&self, agent: &str) -> View {
        let now = self.clock.now_ms();
        let active = i64::try_from(ACTIVE.as_millis()).unwrap_or(i64::MAX);
        let recent = |at: Option<i64>| at.is_some_and(|at| now - at < active);
        let driver = self.driver(agent);
        let mut surfaces = Vec::new();
        {
            let all = lock(&self.surfaces);
            for kind in [Kind::Browser, Kind::Screen] {
                if let Some(s) = all.get(&(agent.to_owned(), kind)) {
                    let live = s.reported_live || recent(s.last);
                    surfaces.push(SurfaceView {
                        kind,
                        live,
                        title: s.title.clone(),
                        since: if live { s.since } else { None },
                        url: s.url.clone(),
                        tab_id: s.tab_id.clone(),
                        backend: s.backend.clone(),
                        last: s.last,
                    });
                }
            }
        }
        let info = self.terminals.info(agent);
        let terminal_live = info.running && (driver == Driver::Person || recent(info.last));
        surfaces.push(SurfaceView {
            kind: Kind::Terminal,
            live: terminal_live,
            title: info.title,
            since: if terminal_live { info.since } else { None },
            url: None,
            tab_id: None,
            backend: None,
            last: info.last,
        });
        let touched = lock(&self.files).get(agent).cloned();
        let files_live = recent(touched.as_ref().map(|t| t.at));
        surfaces.push(SurfaceView {
            kind: Kind::Files,
            live: files_live,
            title: touched.as_ref().and_then(|t| t.path.clone()),
            since: None,
            url: None,
            tab_id: None,
            backend: None,
            last: touched.map(|t| t.at),
        });
        let thread_id = lock(&self.threads).get(agent).cloned();
        View {
            driver,
            thread_id,
            surfaces,
        }
    }

    /// Sends the bot's view if it changed, and keeps watching while anything is live so its
    /// going quiet is sent too.
    pub fn changed(&self, agent: &str) {
        let view = self.view(agent);
        let live = view.surfaces.iter().any(|s| s.live);
        {
            let mut sent = lock(&self.sent);
            if sent.get(agent) != Some(&view) {
                sent.insert(agent.to_owned(), view.clone());
                let _ = self.changes.send(Change::Computer {
                    agent: agent.to_owned(),
                    view,
                });
            }
        }
        if live {
            self.watch(agent);
        }
    }

    fn watch(&self, agent: &str) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        if !lock(&self.watched).insert(agent.to_owned()) {
            return;
        }
        let (me, agent) = (self.me.clone(), agent.to_owned());
        runtime.spawn(async move {
            loop {
                tokio::time::sleep(ACTIVE / 4).await;
                let Some(computers) = me.upgrade() else {
                    return;
                };
                let view = computers.view(&agent);
                let live = view.surfaces.iter().any(|s| s.live);
                if !live {
                    lock(&computers.watched).remove(&agent);
                    computers.changed(&agent);
                    return;
                }
                computers.changed(&agent);
            }
        });
    }

    /// The bot called one of ace's tools for `kind`.
    pub fn bot_used(&self, agent: &str, kind: Kind) {
        let now = self.clock.now_ms();
        {
            let mut all = lock(&self.surfaces);
            let surface = all.entry((agent.to_owned(), kind)).or_default();
            let active = i64::try_from(ACTIVE.as_millis()).unwrap_or(i64::MAX);
            let was_live =
                surface.reported_live || surface.last.is_some_and(|at| now - at < active);
            if !was_live {
                surface.since = Some(now);
            }
            surface.last = Some(now);
        }
        self.changed(agent);
    }

    /// What ace reports about the bot's browser or screen.
    pub fn report(&self, agent: &str, kind: Kind, report: Report) -> Result<(), ComputerError> {
        let now = self.clock.now_ms();
        {
            let mut all = lock(&self.surfaces);
            let surface = all.entry((agent.to_owned(), kind)).or_default();
            if report.live && !surface.reported_live {
                surface.since = Some(now);
            }
            surface.reported_live = report.live;
            surface.title = report.title.map(|t| t.chars().take(200).collect());
            surface.url = report.url.map(|u| u.chars().take(2000).collect());
            surface.tab_id = report.tab_id.map(|t| t.chars().take(200).collect());
            surface.backend = report.backend.map(|b| b.chars().take(32).collect());
            surface.last = Some(now);
        }
        if let Some(thread) = report.thread_id {
            lock(&self.threads).insert(agent.to_owned(), thread.chars().take(200).collect());
        }
        if report.person_acted {
            self.change_record(agent, |record| {
                record.used.insert(kind.word().to_owned());
            })?;
        }
        self.changed(agent);
        Ok(())
    }

    /// Files changed in the bot's workspace: by the app, a tool, or a command (`None`).
    pub fn files_changed(&self, agent: &str, paths: Option<Vec<String>>) {
        let path = paths.as_ref().and_then(|p| p.last().cloned());
        lock(&self.files).insert(
            agent.to_owned(),
            Touched {
                path,
                at: self.clock.now_ms(),
            },
        );
        let _ = self.changes.send(Change::Files {
            agent: agent.to_owned(),
            paths,
        });
        self.changed(agent);
    }

    /// The person wrote `path` through the app (it is trusted: the caller records that).
    pub fn person_wrote(&self, agent: &str, path: &str) {
        let _ = self.change_record_if_held(agent, |record| {
            record.wrote.insert(path.to_owned());
        });
        self.files_changed(agent, Some(vec![path.to_owned()]));
    }

    /// The person entered `lines` at the terminal's prompt.
    pub fn person_entered(&self, agent: &str, lines: Vec<String>) {
        if lines.is_empty() {
            return;
        }
        let _ = self.change_record_if_held(agent, |record| {
            for line in lines {
                if record.commands.len() < MOST_COMMANDS {
                    record.commands.push(line);
                } else {
                    record.more_commands += 1;
                }
            }
        });
        self.files_changed(agent, None);
    }

    /// The person takes the bot's computer. Answers `false` when they had it already.
    pub fn take_over(&self, agent: &str, conversation: &str) -> Result<bool, ComputerError> {
        if self.driver(agent) == Driver::Person {
            return Ok(false);
        }
        let snapshot = self
            .workspaces
            .of(agent)
            .and_then(|w| w.snapshot())
            .unwrap_or_default();
        let record = Record {
            conversation: conversation.to_owned(),
            since: self.clock.now_ms(),
            snapshot,
            ..Record::default()
        };
        // Checked, written and kept under one lock, so no other change can come between.
        {
            let mut records = lock(&self.records);
            if records.contains_key(agent) {
                return Ok(false);
            }
            self.persist(agent, &record)?;
            records.insert(agent.to_owned(), record);
        }
        self.changed(agent);
        Ok(true)
    }

    /// The note for the bot about the person's turn, or `None` when the bot drives.
    pub fn note(&self, agent: &str, handback: Option<&daemon::Handback>) -> Option<note::Note> {
        let record = lock(&self.records).get(agent).cloned()?;
        let now = self
            .workspaces
            .of(agent)
            .and_then(|w| w.snapshot())
            .unwrap_or_default();
        let mut files = changes(&record.snapshot, &now);
        for path in &record.wrote {
            if !files.iter().any(|(p, _)| p == path) {
                files.push((path.clone(), "changed"));
            }
        }
        let used: Vec<String> = record.used.iter().cloned().collect();
        Some(note::note(&note::Driven {
            commands: &record.commands,
            more_commands: record.more_commands,
            files: &files,
            used: &used,
            handback,
        }))
    }

    /// The bot drives again.
    pub fn release(&self, agent: &str) -> Result<(), ComputerError> {
        {
            // Under the lock every change to the record is written under, so none lands after.
            let mut records = lock(&self.records);
            match std::fs::remove_file(self.file(agent)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(ComputerError::Io(error.to_string())),
            }
            records.remove(agent);
        }
        self.changed(agent);
        Ok(())
    }

    /// Forgets the bot's computer and ends its terminal, when the bot is deleted.
    pub fn remove(&self, agent: &str) {
        {
            let mut records = lock(&self.records);
            let _ = std::fs::remove_file(self.file(agent));
            records.remove(agent);
        }
        lock(&self.surfaces).retain(|(a, _), _| a != agent);
        lock(&self.files).remove(agent);
        lock(&self.threads).remove(agent);
        lock(&self.sent).remove(agent);
        self.terminals.remove(agent);
    }

    fn file(&self, agent: &str) -> PathBuf {
        self.root.join(format!("{agent}.json"))
    }

    fn persist(&self, agent: &str, record: &Record) -> Result<(), ComputerError> {
        let text = serde_json::to_string(record).map_err(|e| ComputerError::Io(e.to_string()))?;
        crate::atomic::write_whole(&self.file(agent), &text)
            .map_err(|e| ComputerError::Io(e.to_string()))
    }

    fn change_record(
        &self,
        agent: &str,
        edit: impl FnOnce(&mut Record),
    ) -> Result<(), ComputerError> {
        self.change_record_if_held(agent, edit).map(|_| ())
    }

    /// Changes the person's record and writes it; answers whether they have the computer.
    fn change_record_if_held(
        &self,
        agent: &str,
        edit: impl FnOnce(&mut Record),
    ) -> Result<bool, ComputerError> {
        let mut records = lock(&self.records);
        let Some(record) = records.get_mut(agent) else {
            return Ok(false);
        };
        edit(record);
        // Written before the lock goes, so a release never comes between and no older change
        // is written over a newer one.
        let record = record.clone();
        self.persist(agent, &record)?;
        drop(records);
        Ok(true)
    }
}
