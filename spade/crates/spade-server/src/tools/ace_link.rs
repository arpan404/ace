//! Spade's connection to ace (docs/ace-integration.md, "Spade's grant for ace"). Spade runs on its
//! own, so ace may come and go: this finds the daemon from its files on every connect, calls its
//! MCP endpoint with the grant the daemon handed over, and retries with backoff while the daemon
//! is missing or refuses. ace's tools and skills are there only while connected; everything else
//! in Spade works without them.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use spade_ace::{AceConfig, AceSkills, AceTools, Secret, discover, next_retry_between};
use spade_core::skills::SkillEntry;
use spade_keys::{KeyError, KeyStore};
use tokio::sync::Notify;

use super::{
    AceLibrary, LibraryFuture, SkillLibrary, SkillSource, Tool, ToolSource, WriteError, WriteFuture,
};

/// ace's `wait` can block for up to ten minutes; the engine's own limits still apply.
const CALL_TIMEOUT: Duration = Duration::from_secs(11 * 60);

/// How often a live connection is checked by default (a ping on the MCP session), so a daemon
/// that went away takes its tools with it and the next one is found.
const CHECK: Duration = Duration::from_secs(5);

/// How long ace has to answer a connect or a check before Spade treats it as gone. A daemon that
/// accepts but never answers must not keep its tools listed.
const ANSWER: Duration = Duration::from_secs(5);

/// Where ace is.
#[derive(Debug, Clone)]
pub enum AceTarget {
    /// Found from `<ace home>/daemon-endpoint` and `daemon-token`, with the stored grant.
    Discover(PathBuf),
    /// Given by the `SPADE_ACE_*` variables, for development. Overrides the grant and files.
    Fixed(AceConfig),
}

impl AceTarget {
    /// The `SPADE_ACE_*` variables if all four are set, else `SPADE_ACE_HOME`; none without either.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Option<Self> {
        if let Ok(config) = AceConfig::from_env(&var) {
            return Some(Self::Fixed(config));
        }
        var("SPADE_ACE_HOME")
            .map(|home| home.trim().to_owned())
            .filter(|home| !home.is_empty())
            .map(|home| Self::Discover(PathBuf::from(home)))
    }
}

/// Waits between connects (`first`, doubling up to `longest`), between checks of a live one, and
/// for ace to answer a connect or check.
#[derive(Debug, Clone, Copy)]
pub struct Retry {
    pub first: Duration,
    pub longest: Duration,
    pub check: Duration,
    pub answer: Duration,
}

impl Default for Retry {
    fn default() -> Self {
        Self {
            first: spade_ace::FIRST_RETRY,
            longest: spade_ace::LONGEST_RETRY,
            check: CHECK,
            answer: ANSWER,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GrantError {
    #[error("the grant is empty")]
    Empty,
    #[error(transparent)]
    Keychain(#[from] KeyError),
}

/// What a live connection offers.
struct Connected {
    tools: Vec<Arc<dyn Tool>>,
    skills: Arc<AceSkills>,
}

pub struct AceLink {
    target: AceTarget,
    /// Where the grant is kept. Without a keychain it lives in memory for this run only.
    keys: Option<KeyStore>,
    grant: Mutex<Option<Secret>>,
    /// Changes whenever the grant does, so a connection made with an old grant offers nothing.
    /// Changed and read under the `grant` lock, so a grant and its generation are seen together.
    grants: AtomicU64,
    /// Set once the stored grant has been read (or there is nothing to read).
    loaded: AtomicBool,
    retry: Retry,
    current: RwLock<Option<Connected>>,
    connected: AtomicBool,
    /// Rung when the grant changes, to connect again at once.
    wake: Notify,
    /// Every client made since the grant last changed. A grant change closes them all, so a call
    /// still holding an old one (a tool kept by a running turn) sends nothing more with it.
    clients: Mutex<Vec<Weak<AceTools>>>,
}

/// How to reach ace, with the grant generation its credential belongs to.
struct Attempt {
    config: AceConfig,
    grants: u64,
}

/// Why a connection ended.
enum Ended {
    /// It never came up, or the daemon went away; `connected` if it was up first.
    Lost { connected: bool },
    /// The grant changed.
    Woken,
}

impl AceLink {
    /// Starts connecting in the background. The stored grant is read there too, never before Spade
    /// is serving: reading the keychain can wait on a system prompt (a binary signed differently
    /// after an update), and Spade must come up regardless.
    pub fn start(target: AceTarget, keys: Option<KeyStore>, retry: Retry) -> Arc<Self> {
        let link = Arc::new(Self {
            target,
            keys,
            grant: Mutex::new(None),
            grants: AtomicU64::new(0),
            loaded: AtomicBool::new(false),
            retry,
            current: RwLock::default(),
            connected: AtomicBool::new(false),
            wake: Notify::new(),
            clients: Mutex::default(),
        });
        tokio::spawn(link.clone().run());
        link
    }

    /// Whether ace's tools are reachable now.
    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Waits until ace's tools are reachable, for at most `longest`. Returns whether they are.
    /// Paused turns wait for this after a restart, so a turn about to use an ace tool finds it.
    pub async fn ready_within(&self, longest: Duration) -> bool {
        let until = tokio::time::Instant::now() + longest;
        while !self.connected() {
            if tokio::time::Instant::now() >= until {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        true
    }

    /// Whether Spade holds a grant (or was given ace's credentials directly).
    pub fn has_grant(&self) -> bool {
        matches!(self.target, AceTarget::Fixed(_))
            || self
                .grant
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_some()
    }

    /// Whether Spade holds a grant, once the stored one has been read (waiting up to `longest`
    /// for that read), so a caller never mistakes "not read yet" for "none".
    pub async fn holds_grant(&self, longest: Duration) -> bool {
        let until = tokio::time::Instant::now() + longest;
        while !self.loaded.load(Ordering::SeqCst) && tokio::time::Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.has_grant()
    }

    /// Stores the grant the daemon handed over and connects with it.
    pub fn set_grant(&self, grant: &str) -> Result<(), GrantError> {
        let grant = grant.trim();
        if grant.is_empty() {
            return Err(GrantError::Empty);
        }
        match &self.keys {
            Some(keys) => keys.set_ace_grant(&grant_slot(&self.target), grant)?,
            None => tracing::warn!("no keychain; Spade keeps its ace grant until it stops"),
        }
        {
            let mut held = self.grant.lock().unwrap_or_else(|p| p.into_inner());
            *held = Some(Secret::new(grant));
            self.grants.fetch_add(1, Ordering::SeqCst);
        }
        self.retire_clients();
        self.wake.notify_one();
        Ok(())
    }

    /// Forgets the grant and disconnects.
    pub fn forget_grant(&self) -> Result<(), GrantError> {
        {
            let mut held = self.grant.lock().unwrap_or_else(|p| p.into_inner());
            *held = None;
            self.grants.fetch_add(1, Ordering::SeqCst);
        }
        self.retire_clients();
        self.disconnect();
        self.wake.notify_one();
        if let Some(keys) = &self.keys {
            keys.delete_ace_grant(&grant_slot(&self.target))?;
        }
        Ok(())
    }

    /// Reads the stored grant off the async runtime, unless one was handed over meanwhile.
    async fn load_grant(&self) {
        self.read_stored_grant().await;
        self.loaded.store(true, Ordering::SeqCst);
    }

    async fn read_stored_grant(&self) {
        let Some(keys) = self.keys.clone() else {
            return;
        };
        let before = self.grants.load(Ordering::SeqCst);
        let slot = grant_slot(&self.target);
        let read = tokio::task::spawn_blocking(move || keys.ace_grant(&slot)).await;
        let grant = match read {
            Ok(Ok(grant)) => grant,
            Ok(Err(error)) => {
                tracing::warn!(%error, "could not read Spade's ace grant");
                None
            }
            Err(_) => None,
        };
        if let Some(grant) = grant {
            let mut held = self.grant.lock().unwrap_or_else(|p| p.into_inner());
            // A grant handed over while this read waited is newer: keep it.
            if self.grants.load(Ordering::SeqCst) == before && held.is_none() {
                *held = Some(Secret::new(grant));
            }
        }
    }

    async fn run(self: Arc<Self>) {
        self.load_grant().await;
        let mut wait: Option<Duration> = None;
        loop {
            let ended = match self.attempt() {
                Ok(attempt) => self.connect_and_stay(attempt).await,
                Err(why) => {
                    tracing::debug!(%why, "ace is not reachable yet");
                    Ended::Lost { connected: false }
                }
            };
            self.disconnect();
            match ended {
                Ended::Woken => {
                    wait = None;
                    continue;
                }
                // A connection that worked starts the backoff over.
                Ended::Lost { connected: true } => wait = None,
                Ended::Lost { connected: false } => {}
            }
            let delay = next_retry_between(wait, self.retry.first, self.retry.longest);
            wait = Some(delay);
            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                () = self.wake.notified() => wait = None,
            }
        }
    }

    /// How to reach ace now: the files are read again each time, as the daemon may have moved.
    /// The grant and its generation are read under one lock, so a credential is never paired with
    /// a newer generation (and let through) after the grant changed.
    fn attempt(&self) -> Result<Attempt, String> {
        let (grant, grants) = {
            let held = self.grant.lock().unwrap_or_else(|p| p.into_inner());
            (held.clone(), self.grants.load(Ordering::SeqCst))
        };
        let config = match &self.target {
            AceTarget::Fixed(config) => config.clone(),
            AceTarget::Discover(home) => {
                let grant = grant.ok_or("Spade has no grant for ace yet")?;
                discover(home, grant).map_err(|e| e.to_string())?
            }
        };
        Ok(Attempt { config, grants })
    }

    /// Connects, offers ace's tools, and keeps them current until the daemon goes away or the
    /// grant changes. Only offered while the grant is still the one `attempt` was made with.
    async fn connect_and_stay(&self, attempt: Attempt) -> Ended {
        let Attempt { config, grants } = attempt;
        let client = Arc::new(AceTools::new(config.tools.with_timeout(CALL_TIMEOUT)));
        if !self.register(grants, &client) {
            return Ended::Woken;
        }
        let mut changes = client.changes();
        let list = tokio::select! {
            listed = tokio::time::timeout(self.retry.answer, client.tools()) => match listed {
                Ok(Ok(list)) => list,
                Ok(Err(error)) => {
                    tracing::debug!(%error, "could not reach ace");
                    return Ended::Lost { connected: false };
                }
                Err(_) => {
                    tracing::debug!("ace did not answer in time");
                    return Ended::Lost { connected: false };
                }
            },
            () = self.wake.notified() => return Ended::Woken,
        };
        let skills = Arc::new(AceSkills::new(config.skills));
        if !self.offer(grants, &client, &skills, &list) {
            return Ended::Woken;
        }
        tracing::info!(tools = list.len(), "connected to ace");
        loop {
            tokio::select! {
                changed = changes.changed() => if changed.is_err() {
                    return Ended::Lost { connected: true };
                },
                () = tokio::time::sleep(self.retry.check) => {}
                () = self.wake.notified() => return Ended::Woken,
            }
            // A short check, which a grant change interrupts.
            let checked = tokio::select! {
                checked = tokio::time::timeout(self.retry.answer, client.tools()) => checked,
                () = self.wake.notified() => return Ended::Woken,
            };
            match checked {
                Ok(Ok(list)) => {
                    if !self.offer(grants, &client, &skills, &list) {
                        return Ended::Woken;
                    }
                }
                Ok(Err(error)) => {
                    tracing::info!(%error, "lost ace; its tools are gone until it is back");
                    return Ended::Lost { connected: true };
                }
                Err(_) => {
                    tracing::info!("ace stopped answering; its tools are gone until it is back");
                    return Ended::Lost { connected: true };
                }
            }
        }
    }

    /// Offers `list`, unless the grant changed since the connection began. Returns whether it did.
    fn offer(
        &self,
        grants: u64,
        client: &Arc<AceTools>,
        skills: &Arc<AceSkills>,
        list: &[spade_ace::AceTool],
    ) -> bool {
        let mut current = self.current.write().unwrap_or_else(|p| p.into_inner());
        if self.grants.load(Ordering::SeqCst) != grants {
            return false;
        }
        *current = Some(Connected {
            tools: super::ace::tools(client, list),
            skills: skills.clone(),
        });
        self.connected.store(true, Ordering::SeqCst);
        true
    }

    /// Records a client made under grant generation `grants`; closes it at once if the grant has
    /// changed since. Checked under the lock `retire_clients` takes, so no client escapes both.
    fn register(&self, grants: u64, client: &Arc<AceTools>) -> bool {
        let mut clients = self.clients.lock().unwrap_or_else(|p| p.into_inner());
        if self.grants.load(Ordering::SeqCst) != grants {
            client.close();
            return false;
        }
        clients.retain(|c| c.strong_count() > 0);
        clients.push(Arc::downgrade(client));
        true
    }

    /// Closes every client made with an earlier grant.
    fn retire_clients(&self) {
        let clients = std::mem::take(&mut *self.clients.lock().unwrap_or_else(|p| p.into_inner()));
        for client in clients.iter().filter_map(Weak::upgrade) {
            client.close();
        }
    }

    fn disconnect(&self) {
        self.connected.store(false, Ordering::SeqCst);
        *self.current.write().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// The daemon's WebSocket while connected, for routines' thread events (ADR 0129).
    /// The daemon's brain service with Spade's grant (ADR 0133), found from ace's files now.
    pub fn brains(&self) -> Result<spade_ace::AceBrains, String> {
        self.attempt()
            .map(|attempt| spade_ace::AceBrains::new(&attempt.config.tools))
    }

    pub fn daemon_socket(&self) -> Option<spade_ace::SkillsConfig> {
        self.current
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|c| c.skills.config().clone())
    }

    fn library(&self) -> Option<AceLibrary> {
        self.current
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|c| AceLibrary(c.skills.clone()))
    }
}

impl ToolSource for AceLink {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.current
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|c| c.tools.clone())
            .unwrap_or_default()
    }
}

const AWAY: &str = "ace is not running, or Spade is not connected to it yet";

impl SkillLibrary for AceLink {
    fn list(&self) -> LibraryFuture<Vec<SkillEntry>> {
        match self.library() {
            Some(library) => library.list(),
            None => Box::pin(async { Err(AWAY.to_owned()) }),
        }
    }

    fn read(&self, id: &str) -> LibraryFuture<String> {
        match self.library() {
            Some(library) => library.read(id),
            None => Box::pin(async { Err(AWAY.to_owned()) }),
        }
    }

    fn source(&self, name: &str) -> LibraryFuture<Option<SkillSource>> {
        match self.library() {
            Some(library) => library.source(name),
            None => Box::pin(async { Err(AWAY.to_owned()) }),
        }
    }

    fn create(&self, name: &str, description: &str, body: &str) -> WriteFuture {
        match self.library() {
            Some(library) => library.create(name, description, body),
            None => Box::pin(async { Err(WriteError::Unavailable(AWAY.to_owned())) }),
        }
    }

    fn edit(&self, base: &SkillSource, description: &str, body: &str) -> WriteFuture {
        match self.library() {
            Some(library) => library.edit(base, description, body),
            None => Box::pin(async { Err(WriteError::Unavailable(AWAY.to_owned())) }),
        }
    }
}

/// The keychain slot for this ace home's grant: the first 16 hex digits of the SHA-256 of its
/// canonical path, so a development home and the person's own never share one.
pub fn grant_slot(target: &AceTarget) -> String {
    use sha2::{Digest, Sha256};
    match target {
        AceTarget::Discover(home) => {
            let path = std::fs::canonicalize(home).unwrap_or_else(|_| home.clone());
            let digest = Sha256::digest(path.to_string_lossy().as_bytes());
            digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
        }
        AceTarget::Fixed(_) => "development".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn the_development_variables_override_finding_ace_from_its_home() {
        let both = env(&[
            ("SPADE_ACE_HOME", "/home/me/.ace"),
            ("SPADE_ACE_MCP_URL", "http://127.0.0.1:4400/mcp"),
            ("SPADE_ACE_MCP_TOKEN", "mcp"),
            ("SPADE_ACE_URL", "ws://127.0.0.1:4400/"),
            ("SPADE_ACE_TOKEN", "local"),
        ]);
        assert!(matches!(
            AceTarget::from_env(both),
            Some(AceTarget::Fixed(_))
        ));
        let home = AceTarget::from_env(env(&[("SPADE_ACE_HOME", "/home/me/.ace")]));
        assert!(
            matches!(&home, Some(AceTarget::Discover(path)) if path == Path::new("/home/me/.ace"))
        );
        assert!(AceTarget::from_env(env(&[("SPADE_ACE_HOME", "  ")])).is_none());
    }

    /// A link that does not connect by itself, so a test drives each step.
    fn idle(target: AceTarget) -> AceLink {
        AceLink {
            target,
            keys: None,
            grant: Mutex::new(None),
            grants: AtomicU64::new(0),
            loaded: AtomicBool::new(true),
            retry: Retry {
                answer: Duration::from_millis(300),
                ..Retry::default()
            },
            current: RwLock::default(),
            connected: AtomicBool::new(false),
            wake: Notify::new(),
            clients: Mutex::default(),
        }
    }

    #[tokio::test]
    async fn a_credential_read_before_the_grant_is_forgotten_never_reaches_ace()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let reached = Arc::new(AtomicBool::new(false));
        let seen = reached.clone();
        tokio::spawn(async move {
            // Holds each connection open without answering.
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                seen.store(true, Ordering::SeqCst);
                held.push(socket);
            }
        });
        let mcp = format!("http://127.0.0.1:{port}/mcp");
        let ws = format!("ws://127.0.0.1:{port}/");
        let config = AceConfig::from_env(|key| match key {
            "SPADE_ACE_MCP_URL" => Some(mcp.clone()),
            "SPADE_ACE_URL" => Some(ws.clone()),
            "SPADE_ACE_MCP_TOKEN" | "SPADE_ACE_TOKEN" => Some("old".to_owned()),
            _ => None,
        })?;
        let link = idle(AceTarget::Fixed(config));

        let attempt = link.attempt()?;
        // DELETE /v1/ace lands between reading the credential and connecting with it.
        link.forget_grant()?;
        // The wake-up it rings is for the connect loop, which is not running here.
        let _ = tokio::time::timeout(Duration::ZERO, link.wake.notified()).await;

        let ended = link.connect_and_stay(attempt).await;
        assert!(matches!(ended, Ended::Woken));
        assert!(
            !reached.load(Ordering::SeqCst),
            "the old credential was sent"
        );
        assert!(!link.connected());
        Ok(())
    }
}
