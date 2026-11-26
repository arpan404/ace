// SPDX-License-Identifier: Apache-2.0

//! The pool cases moved from `packages/screen/src/computer/client.process.test.ts`: helpers
//! left idle exit and the next call starts fresh ones (`:173`), and beyond the helper limit the
//! least recently used idle app's helper exits (`:316`). No real helper and no screen: the
//! spawner is a fake process that answers on the connection's own wire.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ace_json::{Map, Value};
use ace_supervisor::signal::SignalName;

use super::{ComputerClient, ComputerClientOptions, RequestOptions, Spawner};
use crate::computer::connection::{ChildEvents, HelperProcess};

/// One fake helper: what it was asked to do, and how it was stopped.
#[derive(Clone, Default)]
struct FakeHelper {
    writes: Arc<Mutex<Vec<String>>>,
    kills: Arc<Mutex<Vec<SignalName>>>,
    /// `end_stdin` was called: the pool is stopping this helper.
    ended: Arc<AtomicBool>,
    /// The helper reported its exit.
    exited: Arc<AtomicBool>,
    /// It outlives SIGTERM, like a helper whose main queue is blocked (`FAKE_IGNORE_STOP`).
    ignores_stop: Arc<AtomicBool>,
    events: Arc<Mutex<Option<Arc<dyn ChildEvents>>>>,
}

impl FakeHelper {
    fn wrote(&self) -> usize {
        self.writes.lock().map(|writes| writes.len()).unwrap_or(0)
    }

    fn end_stdin(&self) {
        self.ended.store(true, Ordering::Relaxed);
    }

    fn exit(&self) {
        self.exited.store(true, Ordering::Relaxed);
        if let Some(events) = self.events.lock().ok().and_then(|events| events.clone()) {
            events.exit();
        }
    }
}

struct FakeProcess(FakeHelper);

impl HelperProcess for FakeProcess {
    fn pid(&self) -> u32 {
        9_000
    }

    fn write(&self, bytes: Vec<u8>) {
        let line = String::from_utf8_lossy(&bytes).into_owned();
        if let Ok(mut writes) = self.0.writes.lock() {
            writes.push(line.clone());
        }
        let Some(value) = ace_json::parse(line.trim()).ok() else {
            return;
        };
        if value.get("op").and_then(Value::as_str) == Some("cancel") {
            return;
        }
        let id = value.get("id").and_then(Value::as_str).unwrap_or_default();
        if let Some(events) = self.0.events.lock().ok().and_then(|events| events.clone()) {
            events.output(
                format!("{{\"id\":\"{id}\",\"ok\":true,\"result\":{{\"app\":\"ok\"}}}}\n")
                    .into_bytes(),
            );
        }
    }

    fn end_stdin(&self) {
        self.0.end_stdin();
    }

    fn kill(&self, signal: SignalName) -> bool {
        if let Ok(mut kills) = self.0.kills.lock() {
            kills.push(signal);
        }
        match signal {
            SignalName::Term if self.0.ignores_stop.load(Ordering::Relaxed) => {}
            SignalName::Term | SignalName::Kill => self.0.exit(),
        }
        true
    }
}

/// The helpers the pool started, in start order.
#[derive(Clone, Default)]
struct FakeWorld {
    helpers: Arc<Mutex<Vec<FakeHelper>>>,
    spawns: Arc<AtomicU32>,
}

impl FakeWorld {
    fn spawned(&self) -> usize {
        self.spawns.load(Ordering::Relaxed) as usize
    }

    fn helper(&self, index: usize) -> FakeHelper {
        self.helpers
            .lock()
            .ok()
            .and_then(|helpers| helpers.get(index).cloned())
            .unwrap_or_else(|| panic!("no helper {index}"))
    }

    fn spawner(&self) -> Spawner {
        let world = self.clone();
        Arc::new(move |_command, _args, _env, events| {
            let helper = FakeHelper {
                events: Arc::new(Mutex::new(Some(events))),
                ..FakeHelper::default()
            };
            world.spawns.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut helpers) = world.helpers.lock() {
                helpers.push(helper.clone());
            }
            Ok(Box::new(FakeProcess(helper)) as Box<dyn HelperProcess>)
        })
    }
}

fn client(world: &FakeWorld, configure: impl FnOnce(&mut ComputerClientOptions)) -> ComputerClient {
    let ids = Arc::new(AtomicU32::new(0));
    let mut options = ComputerClientOptions::new(
        Arc::new(|| Box::pin(async { Ok("/fake/ace-screen-helper".to_owned()) })),
        Arc::new(move || format!("r{}", ids.fetch_add(1, Ordering::Relaxed) + 1)),
    );
    options.spawn = world.spawner();
    options.environment = Arc::new(|| Box::pin(async { Ok(Vec::new()) }));
    options.grace_ms = 50;
    options.force_kill_ms = 100;
    configure(&mut options);
    ComputerClient::new(options)
}

fn payload(app: &str) -> Map {
    let mut payload = Map::new();
    payload.insert("app".to_owned(), Value::from(app));
    payload
}

/// A request, and long enough for its connection to notice that the app went idle.
async fn request(client: &ComputerClient, app: &str) {
    let result = client
        .request("state", &payload(app), RequestOptions::default())
        .await;
    assert!(result.is_ok(), "{app} answered: {result:?}");
    // The idle callback follows the settled promise on the connection's task.
    tokio::time::sleep(Duration::from_millis(20)).await;
}

/// `client.process.test.ts:173`: helpers left idle exit, and the next call starts fresh ones.
#[tokio::test]
async fn helpers_left_idle_exit_and_the_next_call_starts_fresh_ones() {
    let world = FakeWorld::default();
    let client = client(&world, |options| options.idle_ms = 60);
    request(&client, "Calculator").await;
    assert_eq!(world.spawned(), 1);
    let first = world.helper(0);
    assert!(!first.exited.load(Ordering::Relaxed));

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        first.exited.load(Ordering::Relaxed),
        "the idle helper exited"
    );

    request(&client, "Calculator").await;
    assert_eq!(world.spawned(), 2, "the next call started a fresh helper");
}

/// `client.process.test.ts:316`: beyond the limit, the least recently used idle app's helper
/// exits, and the app used last keeps its own.
#[tokio::test]
async fn beyond_the_helper_limit_the_least_recently_used_idle_apps_helper_exits() {
    let world = FakeWorld::default();
    let client = client(&world, |options| options.max_helpers = 2);
    request(&client, "Calculator").await;
    let calculator = world.helper(0);
    request(&client, "TextEdit").await;
    let text_edit = world.helper(1);
    request(&client, "Calculator").await;
    request(&client, "Frozen").await;
    assert_eq!(world.spawned(), 3);

    assert!(
        text_edit.exited.load(Ordering::Relaxed),
        "the least recently used idle app's helper exits"
    );
    assert!(
        !calculator.exited.load(Ordering::Relaxed),
        "the app used last keeps its helper"
    );
    assert!(world.helper(2).wrote() == 1);
}

/// An eviction that lands while a helper is being spawned still records that helper as the
/// app's predecessor, so the app's successor waits for it to exit; two helpers for one app
/// never run at once (`client.ts:166`-`:177`, `:241`-`:251`; `client.process.test.ts:210`).
#[tokio::test]
async fn an_eviction_during_a_start_keeps_its_helper_as_the_predecessor() {
    let helpers: Arc<Mutex<Vec<FakeHelper>>> = Arc::new(Mutex::new(Vec::new()));
    let starts_after_exit: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
    let slot: Arc<Mutex<Option<ComputerClient>>> = Arc::new(Mutex::new(None));
    let spawns = Arc::new(AtomicU32::new(0));
    let ids = Arc::new(AtomicU32::new(0));
    let mut options = ComputerClientOptions::new(
        Arc::new(|| Box::pin(async { Ok("/fake/ace-screen-helper".to_owned()) })),
        Arc::new(move || format!("r{}", ids.fetch_add(1, Ordering::Relaxed) + 1)),
    );
    options.max_helpers = 1;
    options.idle_ms = 60_000;
    options.grace_ms = 50;
    options.force_kill_ms = 100;
    options.spawn = {
        let helpers = Arc::clone(&helpers);
        let starts_after_exit = Arc::clone(&starts_after_exit);
        let slot = Arc::clone(&slot);
        let spawns = Arc::clone(&spawns);
        Arc::new(move |_command, _args, _env, events| {
            let number = spawns.fetch_add(1, Ordering::Relaxed);
            let earlier_exited = helpers
                .lock()
                .map(|helpers| {
                    helpers
                        .iter()
                        .all(|helper| helper.exited.load(Ordering::Relaxed))
                })
                .unwrap_or(false);
            if let Ok(mut starts) = starts_after_exit.lock() {
                starts.push(earlier_exited);
            }
            if number == 0 {
                // The eviction lands while this spawn is in flight.
                let client = slot
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone())
                    .unwrap_or_else(|| panic!("the client"));
                let mut pool = client.pool();
                super::drop_entry(&client.shared, &mut pool, "calculator");
            }
            let helper = FakeHelper {
                // The first helper outlives SIGTERM, so a successor beside it would show.
                ignores_stop: Arc::new(AtomicBool::new(number == 0)),
                events: Arc::new(Mutex::new(Some(events))),
                ..FakeHelper::default()
            };
            if let Ok(mut helpers) = helpers.lock() {
                helpers.push(helper.clone());
            }
            Ok(Box::new(FakeProcess(helper)) as Box<dyn HelperProcess>)
        })
    };
    let client = ComputerClient::new(options);
    if let Ok(mut slot) = slot.lock() {
        *slot = Some(client.clone());
    }
    let first = client
        .request("state", &payload("calculator"), RequestOptions::default())
        .await;
    assert!(first.is_err(), "its connection was evicted under it");
    let second = client
        .request("state", &payload("calculator"), RequestOptions::default())
        .await;
    assert!(
        second.is_ok(),
        "the successor starts once the old helper exits"
    );
    assert_eq!(
        starts_after_exit
            .lock()
            .map(|starts| starts.clone())
            .unwrap_or_default(),
        vec![true, true],
        "the successor started only after the evicted start's helper exited"
    );
}
