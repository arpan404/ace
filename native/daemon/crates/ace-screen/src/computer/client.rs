// SPDX-License-Identifier: Apache-2.0

//! The daemon's side of `ace-screen-helper --computer` (`computer/client.ts`): a pool of
//! helpers, one per target app, plus one shared catalog helper. Each app's helper runs its own
//! requests, so agents in different apps run in parallel and a hung app stalls only its own.
//! Helpers start on first use, restart after they exit, and exit after a while idle. At most
//! `max_helpers` app helpers live; the least recently used idle one goes.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use ace_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use super::connection::{
    ChildEvents, Connection, ConnectionOptions, Dispatch, HelperProcess, HelperStart, StartFuture,
};
use super::timing::{Clock, RequestTiming};
use crate::error::ComputerError;

/// How long each op may run, from when it is sent (`client.ts:80`): a batch of actions takes
/// longest, and reading an outline's second.
pub fn default_deadline_ms(op: &str) -> u64 {
    match op {
        "act" => 85_000,
        "state" => 40_000,
        _ => 15_000,
    }
}

/// Resolves the installed helper, read before every start (`client.ts:22`).
pub type HelperPath = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<String, ComputerError>> + Send>> + Send + Sync,
>;

/// The helper's environment, read before every start (`client.ts:29`). Linux carries the
/// graphical session here; a refusal is the message the model reads.
pub type HelperEnvironment = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<Vec<(String, String)>, ComputerError>> + Send>>
        + Send
        + Sync,
>;

/// Starts one helper process (`client.ts:33`). Production spawns it through `ace-supervisor`
/// (`crate::computer::spawn`); a test substitutes its own.
pub type Spawner = Arc<
    dyn Fn(
            String,
            Vec<String>,
            Vec<(String, String)>,
            Arc<dyn ChildEvents>,
        ) -> Result<Box<dyn HelperProcess>, ComputerError>
        + Send
        + Sync,
>;

/// Everything the pool needs (`client.ts:20`). The helper's path and the id generator are
/// required: the generator is never defaulted, because a cancel's acknowledgment must never
/// share the action's id (see `ConnectionOptions::new`).
pub struct ComputerClientOptions {
    /// The installed helper executable, resolved before every start.
    pub helper: HelperPath,
    /// The helper's environment, read before every start.
    pub environment: HelperEnvironment,
    /// Arguments after `--computer`, such as Linux's `--data-dir`.
    pub helper_args: Vec<String>,
    /// Starts a helper with its command, arguments, environment and events sink.
    pub spawn: Spawner,
    /// How long each op may run, from when it is sent.
    pub deadline_ms: Arc<dyn Fn(&str) -> u64 + Send + Sync>,
    /// How long a cancelled or overdue request may take to reply before its helper is killed.
    pub grace_ms: u64,
    /// Windows: how long a helper may take to exit after stdin closes before it is killed.
    pub stop_grace_ms: u64,
    /// How long a stopping helper may take to exit before it is force-killed.
    pub force_kill_ms: u64,
    /// How long an app's helper may sit idle before it exits.
    pub idle_ms: u64,
    /// App helpers kept alive at once.
    pub max_helpers: usize,
    /// Largest reply line accepted.
    pub max_reply_bytes: usize,
    pub now: Clock,
    pub next_id: Arc<dyn Fn() -> String + Send + Sync>,
    /// Optional diagnostics: durations only, never arguments, titles or screenshots.
    pub timing: Option<Arc<dyn Fn(RequestTiming) + Send + Sync>>,
}

impl ComputerClientOptions {
    /// A pool ready for production once a spawner is set (`client.ts:20`): the helper's path and
    /// the id generator are the caller's, never invented here.
    pub fn new(
        helper: HelperPath,
        next_id: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> ComputerClientOptions {
        ComputerClientOptions {
            helper,
            environment: Arc::new(|| Box::pin(async { Ok(Vec::new()) })),
            helper_args: Vec::new(),
            spawn: Arc::new(|_, _, _, _| Err(ComputerError::helper_unavailable())),
            deadline_ms: Arc::new(default_deadline_ms),
            grace_ms: 3_000,
            stop_grace_ms: 0,
            force_kill_ms: 3_000,
            idle_ms: 5 * 60_000,
            max_helpers: 6,
            max_reply_bytes: 32 * 1024 * 1024,
            now: Arc::new(|| 0.0),
            next_id,
            timing: None,
        }
    }
}

/// What a request acts on (`client.ts:61`).
#[derive(Default)]
pub struct RequestOptions {
    /// The app the request acts on; defaults to the payload's `app` for state and act.
    pub app: Option<String>,
    /// Stops the request (`AbortSignal`).
    pub cancel: Option<CancellationToken>,
    /// Rechecked just before native stdin; waiting releases the helper queue.
    pub dispatch: Option<Arc<dyn Dispatch>>,
}

/// Ops about the computer as a whole rather than one app (`client.ts:70`-`:76`).
const CATALOG_OPS: [&str; 5] = ["hello", "apps", "resolve", "displays", "capture_displays"];
const CATALOG: &str = "\u{0}catalog";

/// One app's slot (`client.ts:84`).
struct Entry {
    /// This entry's own number: a timer or callback from an evicted one changes nothing.
    generation: u64,
    connection: Connection,
    /// Whether this connection ever spawned a helper; one that never did retires nothing.
    spawned: Arc<AtomicBool>,
    idle: bool,
    /// Use order, for least-recently-used eviction.
    used: u64,
    stop_idle: Option<CancellationToken>,
}

struct Pool {
    entries: HashMap<String, Entry>,
    /// Per app, the dropped connection whose helper may still run (`client.ts:104`). At most
    /// one, since a successor spawns only once it has exited.
    retiring: HashMap<String, Connection>,
    uses: u64,
    next_generation: u64,
    closed: bool,
}

impl Pool {
    fn next_generation(&mut self) -> u64 {
        self.next_generation += 1;
        self.next_generation
    }

    fn bump_use(&mut self) -> u64 {
        self.uses += 1;
        self.uses
    }
}

struct Shared {
    options: Arc<ComputerClientOptions>,
    pool: Mutex<Pool>,
}

/// The app's helper pool (`ComputerClient`, `client.ts:96`).
#[derive(Clone)]
pub struct ComputerClient {
    shared: Arc<Shared>,
}

impl ComputerClient {
    pub fn new(options: ComputerClientOptions) -> Self {
        Self {
            shared: Arc::new(Shared {
                options: Arc::new(options),
                pool: Mutex::new(Pool {
                    entries: HashMap::new(),
                    retiring: HashMap::new(),
                    uses: 0,
                    next_generation: 0,
                    closed: false,
                }),
            }),
        }
    }

    fn pool(&self) -> MutexGuard<'_, Pool> {
        self.shared
            .pool
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// One request (`client.ts:114`): the app's helper, starting it if needed.
    pub async fn request(
        &self,
        op: &str,
        payload: &Map,
        options: RequestOptions,
    ) -> Result<Value, ComputerError> {
        if self.pool().closed {
            return Err(ComputerError::closed());
        }
        let target = payload.get("app").and_then(Value::as_str);
        let key = if CATALOG_OPS.contains(&op) {
            CATALOG.to_owned()
        } else {
            options
                .app
                .clone()
                .or_else(|| target.map(str::to_owned))
                .unwrap_or_else(|| CATALOG.to_owned())
                .to_lowercase()
        };
        let connection = {
            let mut pool = self.pool();
            let connection = entry_for(&self.shared, &mut pool, &key);
            let uses = pool.bump_use();
            // About to take a request: never the one trimmed to make room for itself.
            if let Some(entry) = pool.entries.get_mut(&key) {
                entry.used = uses;
                entry.idle = false;
                if let Some(token) = entry.stop_idle.take() {
                    token.cancel();
                }
            }
            connection
        };
        let deadline = (self.shared.options.deadline_ms)(op);
        connection
            .request(op, payload, deadline, options.cancel, options.dispatch)
            .await
    }

    /// The process id of the helper that runs `app`'s state and act requests, starting it if
    /// needed (`client.ts:138`): locked use counts input that process posts as the agent's.
    pub async fn helper_process_id(&self, app: &str) -> Option<u32> {
        if self.pool().closed {
            return None;
        }
        let connection = {
            let mut pool = self.pool();
            entry_for(&self.shared, &mut pool, &app.to_lowercase())
        };
        connection.pid().await
    }

    /// Stops every helper (`client.ts:143`).
    pub fn close(&self) {
        let (connections, retiring) = {
            let mut pool = self.pool();
            pool.closed = true;
            let entries = std::mem::take(&mut pool.entries);
            let retiring = std::mem::take(&mut pool.retiring);
            for entry in entries.values() {
                if let Some(token) = &entry.stop_idle {
                    token.cancel();
                }
            }
            let connections: Vec<Connection> = entries
                .into_values()
                .map(|entry| entry.connection)
                .collect();
            (connections, retiring.into_values().collect::<Vec<_>>())
        };
        for connection in connections.iter().chain(retiring.iter()) {
            connection.close();
        }
    }

    /// An app's helper went idle or busy (`client.ts:216`): arm or cancel its idle exit, then
    /// trim the pool.
    fn idle_changed(&self, key: &str, generation: u64, idle: bool) {
        let mut pool = self.pool();
        let Some(entry) = pool.entries.get_mut(key) else {
            return;
        };
        if entry.generation != generation {
            return;
        }
        entry.idle = idle;
        if let Some(token) = entry.stop_idle.take() {
            token.cancel();
        }
        if !idle {
            return;
        }
        let token = CancellationToken::new();
        entry.stop_idle = Some(token.clone());
        let weak = Arc::downgrade(&self.shared);
        let app = key.to_owned();
        let idle_ms = self.shared.options.idle_ms;
        tokio::spawn(async move {
            tokio::select! {
                () = tokio::time::sleep(std::time::Duration::from_millis(idle_ms)) => {}
                () = token.cancelled() => return,
            }
            if let Some(shared) = weak.upgrade() {
                ComputerClient { shared }.drop_if_idle(&app, generation);
            }
        });
        trim(&self.shared, &mut pool);
    }

    /// Left idle, the app's connection exits (`client.ts:221`).
    fn drop_if_idle(&self, key: &str, generation: u64) {
        let mut pool = self.pool();
        let stale = pool
            .entries
            .get(key)
            .is_none_or(|entry| entry.generation != generation || !entry.idle);
        if stale {
            return;
        }
        drop_entry(&self.shared, &mut pool, key);
    }
}

/// The app's (or catalog's) connection, made on first use (`client.ts:152`).
fn entry_for(shared: &Arc<Shared>, pool: &mut Pool, key: &str) -> Connection {
    if let Some(entry) = pool.entries.get(key) {
        return entry.connection.clone();
    }
    let before = pool.retiring.get(key).cloned();
    let spawned = Arc::new(AtomicBool::new(false));
    let generation = pool.next_generation();
    let used = pool.bump_use();
    let connection = connect(shared, key, generation, Arc::clone(&spawned), before);
    pool.entries.insert(
        key.to_owned(),
        Entry {
            generation,
            connection: connection.clone(),
            spawned,
            idle: false,
            used,
            stop_idle: None,
        },
    );
    trim(shared, pool);
    connection
}

/// Build one app's connection, whose start waits for the app's retired helper first.
fn connect(
    shared: &Arc<Shared>,
    key: &str,
    generation: u64,
    spawned: Arc<AtomicBool>,
    before: Option<Connection>,
) -> Connection {
    let options = Arc::clone(&shared.options);
    let starter = Arc::new(PoolStart {
        shared: Arc::downgrade(shared),
        key: key.to_owned(),
        generation,
        spawned,
        before,
        options: Arc::clone(&options),
    });
    let weak = Arc::downgrade(shared);
    let idle_key = key.to_owned();
    let idle = Arc::new(move |idle: bool| {
        if let Some(shared) = weak.upgrade() {
            ComputerClient { shared }.idle_changed(&idle_key, generation, idle);
        }
    });
    let app = (key != CATALOG).then(|| key.to_owned());
    Connection::start(ConnectionOptions {
        start: starter,
        next_id: Arc::clone(&options.next_id),
        now: Arc::clone(&options.now),
        max_reply_bytes: options.max_reply_bytes,
        grace_ms: options.grace_ms,
        stop_grace_ms: options.stop_grace_ms,
        force_kill_ms: options.force_kill_ms,
        idle,
        app,
        timing: options.timing.clone(),
    })
}

/// Over the limit, the least recently used idle app helpers exit (`client.ts:228`).
fn trim(shared: &Arc<Shared>, pool: &mut Pool) {
    let max = shared.options.max_helpers;
    let mut apps: Vec<(String, u64, bool, bool)> = pool
        .entries
        .iter()
        .filter(|(key, _)| key.as_str() != CATALOG)
        .map(|(key, entry)| {
            (
                key.clone(),
                entry.used,
                entry.idle,
                entry.connection.is_closed(),
            )
        })
        .collect();
    let mut excess = apps.len().saturating_sub(max);
    if excess == 0 {
        return;
    }
    apps.sort_by_key(|(_, used, _, _)| *used);
    for (key, _, idle, closed) in apps {
        if excess == 0 {
            break;
        }
        if closed || !idle {
            continue;
        }
        drop_entry(shared, pool, &key);
        excess -= 1;
    }
}

/// Take one app's connection out of the pool (`client.ts:241`).
fn drop_entry(shared: &Arc<Shared>, pool: &mut Pool, key: &str) {
    let Some(entry) = pool.entries.remove(key) else {
        return;
    };
    if let Some(token) = entry.stop_idle {
        token.cancel();
    }
    entry.connection.close();
    // One that never spawned leaves the app's retired connection, if any, as it is.
    if !entry.spawned.load(Ordering::Relaxed) {
        return;
    }
    pool.retiring
        .insert(key.to_owned(), entry.connection.clone());
    let weak = Arc::downgrade(shared);
    let retired = entry.connection;
    let app = key.to_owned();
    tokio::spawn(async move {
        retired.gone().await;
        let Some(shared) = weak.upgrade() else {
            return;
        };
        let mut pool = shared
            .pool
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pool
            .retiring
            .get(&app)
            .is_some_and(|current| current == &retired)
        {
            pool.retiring.remove(&app);
        }
    });
}

/// A pool entry's start: wait for the retired helper, read the environment and the path, spawn
/// (`client.ts:157`-`:177`).
struct PoolStart {
    shared: Weak<Shared>,
    key: String,
    generation: u64,
    spawned: Arc<AtomicBool>,
    before: Option<Connection>,
    options: Arc<ComputerClientOptions>,
}

impl PoolStart {
    /// Whether this entry is closed or gone: a start that is no longer wanted spawns nothing.
    fn closed(&self) -> bool {
        let Some(shared) = self.shared.upgrade() else {
            return true;
        };
        let pool = shared
            .pool
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match pool.entries.get(&self.key) {
            Some(entry) => entry.generation != self.generation || entry.connection.is_closed(),
            None => true,
        }
    }

    /// The retired helper at this app's key is this one, now exited: let the app start over.
    fn retire(&self, before: &Connection) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let client = ComputerClient { shared };
        let mut pool = client.pool();
        if pool
            .retiring
            .get(&self.key)
            .is_some_and(|current| current == before)
        {
            pool.retiring.remove(&self.key);
        }
    }
}

impl HelperStart for PoolStart {
    fn start(&self, events: Arc<dyn ChildEvents>) -> StartFuture {
        let shared = self.shared.clone();
        let key = self.key.clone();
        let generation = self.generation;
        let spawned = Arc::clone(&self.spawned);
        let before = self.before.clone();
        let options = Arc::clone(&self.options);
        let start = PoolStart {
            shared,
            key,
            generation,
            spawned,
            before,
            options,
        };
        Box::pin(async move {
            if start.closed() {
                return Err(ComputerError::stopped());
            }
            if let Some(before) = &start.before {
                // Fails at once with helper_stopping while the old helper refuses to die.
                before.stopped().await?;
                start.retire(before);
            }
            let environment = (start.options.environment)().await?;
            let command = (start.options.helper)().await?;
            // Dropped while the helper was resolved: its successor may be starting already.
            if start.closed() {
                return Err(ComputerError::stopped());
            }
            let mut args = vec!["--computer".to_owned()];
            args.extend(start.options.helper_args.iter().cloned());
            let process = (start.options.spawn)(command, args, environment, events)?;
            start.spawned.store(true, Ordering::Relaxed);
            Ok(process)
        })
    }
}

#[cfg(test)]
mod tests;
