//! Two (or more) Spades with a fake fleet of daemons between them (ADR 0187): each inbox
//! request is stamped and signed as ace's daemon does, and the fleet can lose answers, change a
//! part on the way, go unreachable or send as another machine. Each machine runs Spade's
//! security service with the key ace's daemon shares, so the person's stamp can be made.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use spade_server::clock::{CountingIds, Ids, SystemClock};
use spade_server::security::{Security, Setup};
use spade_server::teams::proof::inbox_proof;
use spade_server::teams::{BoxFuture, Machine, Remote, RemoteError};
use spade_server::tools::EngineHandle;
use spade_store::Store;
use spade_testkit::Script;

use super::{Options, Result, Spade, TOKEN};

/// Both daemons' local token, in each ace home: what signs a forwarded inbox request.
pub const DAEMON_TOKEN: &str = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";

/// The key each machine's daemon shares with its Spade for the person's stamps.
const PERSON_KEY: [u8; 32] = [7; 32];

/// Ids that never collide between the machines, as UUIDs never do.
struct MachineIds(&'static str, AtomicU64);

impl Ids for MachineIds {
    fn next(&self, prefix: &str) -> String {
        format!(
            "{prefix}_{}{}",
            self.0,
            self.1.fetch_add(1, Ordering::SeqCst) + 1
        )
    }
}

/// What the fake daemons carry between the Spades, and how they misbehave on purpose.
#[derive(Default)]
pub struct Fleet {
    /// host id → (Spade's address, machine name).
    pub spades: Mutex<Vec<(String, String, String)>>,
    pub offline: Mutex<HashSet<String>>,
    /// Listed online, but every call is lost before it arrives.
    pub unreachable: AtomicBool,
    /// Drops one note row from the next notes part on the way.
    pub change_notes: AtomicBool,
    /// Renames the next file part's path on the way.
    pub change_file_path: AtomicBool,
    /// Delivers the next commit, then says the connection was lost.
    pub lose_commit_answer: AtomicBool,
    /// Every request body carried, as sent.
    pub carried: Mutex<Vec<String>>,
}

/// One machine's daemon as its Spade sees it.
pub struct Link {
    pub me: String,
    pub fleet: Arc<Fleet>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// One inbox request to `base` as the daemon forwards it from `sender` (named `name`).
pub async fn deliver(
    base: &str,
    sender: &str,
    name: &str,
    request: &Value,
) -> Result<(u16, Value)> {
    let body = serde_json::to_vec(request)?;
    let time = now_ms();
    let proof = inbox_proof(DAEMON_TOKEN, time, sender, name, &body).unwrap_or_default();
    let answer = reqwest::Client::new()
        .post(format!("{base}/v1/inbox"))
        .bearer_auth(TOKEN)
        .header("content-type", "application/json")
        .header("x-ace-from-host", sender)
        .header("x-ace-from-name", name)
        .header("x-ace-inbox-time", time.to_string())
        .header("x-ace-inbox-proof", proof)
        .body(body)
        .send()
        .await?;
    let status = answer.status().as_u16();
    Ok((status, answer.json().await.unwrap_or(Value::Null)))
}

impl Remote for Link {
    fn host(&self) -> Option<String> {
        Some(self.me.clone())
    }

    fn machines(&self) -> BoxFuture<'_, std::result::Result<Vec<Machine>, RemoteError>> {
        Box::pin(async move {
            let offline = lock(&self.fleet.offline).clone();
            Ok(lock(&self.fleet.spades)
                .iter()
                .filter(|(host, _, _)| *host != self.me)
                .map(|(host, _, name)| Machine {
                    host_id: host.clone(),
                    name: name.clone(),
                    online: !offline.contains(host),
                })
                .collect())
        })
    }

    fn call(
        &self,
        machine: &str,
        mut request: Value,
    ) -> BoxFuture<'_, std::result::Result<(u16, Value), RemoteError>> {
        let machine = machine.to_owned();
        Box::pin(async move {
            let (base, my_name) = {
                let spades = lock(&self.fleet.spades);
                let base = spades
                    .iter()
                    .find(|(host, _, _)| *host == machine)
                    .map(|(_, base, _)| base.clone())
                    .ok_or_else(|| RemoteError::UnknownMachine(machine.clone()))?;
                let mine = spades
                    .iter()
                    .find(|(host, _, _)| *host == self.me)
                    .map(|(_, _, name)| name.clone())
                    .unwrap_or_default();
                (base, mine)
            };
            if self.fleet.unreachable.load(Ordering::SeqCst)
                || lock(&self.fleet.offline).contains(&machine)
            {
                return Err(RemoteError::Offline);
            }
            let part = &mut request["part"];
            if part["table"] == "notes"
                && self.fleet.change_notes.swap(false, Ordering::SeqCst)
                && let Some(rows) = part["rows"].as_array_mut()
            {
                rows.pop();
            }
            if part["kind"] == "file" && self.fleet.change_file_path.swap(false, Ordering::SeqCst) {
                part["path"] = Value::String("drafts/planted.sh".to_owned());
            }
            lock(&self.fleet.carried).push(request.to_string());
            let answer = deliver(&base, &self.me, &my_name, &request)
                .await
                .map_err(|_| RemoteError::Offline)?;
            if request["step"] == "commit"
                && self.fleet.lose_commit_answer.swap(false, Ordering::SeqCst)
            {
                return Err(RemoteError::Disconnected);
            }
            Ok(answer)
        })
    }
}

/// A machine: its Spade (ace's home holding the daemon's tokens), its security service, linked
/// into the fleet.
pub async fn machine(
    fleet: &Arc<Fleet>,
    host: &str,
    name: &str,
    scripts: Vec<Script>,
) -> Result<Spade> {
    let home = tempfile::tempdir()?.keep();
    std::fs::write(home.join("daemon-token"), format!("{DAEMON_TOKEN}\n"))?;
    let key = home.join(spade_server::security::attest::KEY_FILE);
    std::fs::write(
        &key,
        PERSON_KEY
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
    )?;
    let tag = if host == "host-laptop" { "l" } else { "s" };
    let spade = Spade::start_with(
        scripts,
        Vec::new(),
        Options {
            ace_home: Some(home.clone()),
            ids: Some(Arc::new(MachineIds(tag, AtomicU64::new(0)))),
            connectors: true,
            ..Options::default()
        },
    )
    .await?;
    let bots = EngineHandle::default();
    bots.set(&spade.engine);
    let data = spade.dir.path().to_path_buf();
    let security = Security::start(Setup {
        runner: spade_sandbox::Runner::unavailable("no sandbox in this test"),
        store: Store::open(&spade.database())?,
        home: home.clone(),
        spade_data: data.clone(),
        ace_data: None,
        workspaces: data.join("workspace"),
        log_dir: data.join("egress"),
        clock: Arc::new(SystemClock),
        ids: Arc::new(CountingIds::default()),
        bots,
        person_key: Some(key),
    })
    .await;
    spade.engine.set_security(security);
    lock(&fleet.spades).push((host.to_owned(), spade.base.clone(), name.to_owned()));
    link(fleet, host, &spade);
    Ok(spade)
}

/// Links (again, after a restart) `spade` into the fleet as `host`.
pub fn link(fleet: &Arc<Fleet>, host: &str, spade: &Spade) {
    if let Some(entry) = lock(&fleet.spades).iter_mut().find(|(h, _, _)| h == host) {
        entry.1 = spade.base.clone();
    }
    spade.engine.set_remote(Arc::new(Link {
        me: host.to_owned(),
        fleet: fleet.clone(),
    }));
}

/// The person's stamp, as their machine's daemon adds it, on `target` becoming `value`.
pub fn stamp(target: &str, value: &str) -> String {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    spade_server::security::attest::sign(&PERSON_KEY, target, value, now_ms(), &nonce)
}

/// `PUT /v1/moves/{move}/accept {bot}` on `spade`, with the person's stamp unless `stamped`
/// is false.
pub async fn accept(spade: &Spade, id: &str, bot: &str, stamped: bool) -> Result<u16> {
    let mut request = spade
        .http
        .put(format!("{}/v1/moves/{id}/accept", spade.base))
        .bearer_auth(TOKEN)
        .json(&serde_json::json!({ "bot": bot }));
    if stamped {
        request = request.header(
            spade_server::security::attest::HEADER,
            stamp(&format!("move:{id}"), &format!("accept:{bot}")),
        );
    }
    Ok(request.send().await?.status().as_u16())
}

/// Accepts the move on `to`, then starts it on `from`: the app's one click. Answers the start.
pub async fn move_bot(
    from: &Spade,
    to: &Spade,
    bot: &str,
    id: &str,
    host: &str,
) -> Result<(u16, Value)> {
    assert_eq!(accept(to, id, bot, true).await?, 200, "accepted there");
    from.post(
        &format!("/v1/agents/{bot}/move"),
        serde_json::json!({ "to": host, "move": id }),
    )
    .await
}

/// Waits until the move from `spade` ends; answers its last view (`null` once it is done or
/// cancelled).
pub async fn move_ends(spade: &Spade, bot: &str) -> Result<Value> {
    let mut last = Value::Null;
    for _ in 0..600 {
        let (_, body) = spade.get(&format!("/v1/agents/{bot}/move")).await?;
        last = body.clone();
        if body["move"].is_null() || body["move"]["state"] == "failed" {
            return Ok(body["move"].clone());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err(format!("the move never ended: {last}").into())
}
