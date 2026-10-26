//! The ops: `hello`, `apps`, `resolve`, `state` and `act`, one at a time.
use crate::computer::act::Actor;
use crate::computer::apps::{self, RunningApp};
use crate::computer::bus::Bus;
use crate::computer::cancel::{Cancellations, Checkpoint};
use crate::computer::catalog::{self, Candidate};
use crate::computer::desktop::DesktopApp;
use crate::computer::error::{CuError, CuResult};
use crate::computer::events::Activity;
use crate::computer::observe::{self, Options};
use crate::computer::screencast::ScreenCast;
use crate::computer::session::AppSession;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Wayland lets ace send no pointer input, so hover and drag are left out.
const CAPABILITIES: [&str; 18] = [
    "click",
    "type",
    "paste",
    "key",
    "set_value",
    "select_text",
    "scroll",
    "scroll_to",
    "action",
    "menu",
    "focus",
    "window",
    "wait",
    "wait_for",
    "activate",
    "cancel",
    "outline_off",
    "when",
];

pub struct Service {
    #[allow(dead_code)]
    cancellations: Cancellations,
    bus: Option<Bus>,
    activity: Activity,
    cast_tried: bool,
    sessions: HashMap<u32, AppSession>,
    resolved: HashMap<String, u32>,
    /// Wayland screenshots, through the ScreenCast portal.
    cast: Option<ScreenCast>,
    /// Where restore tokens are kept (`--data-dir`); without it they last for this process.
    data_dir: Option<PathBuf>,
}

fn flag(body: &Map<String, Value>, key: &str, default: bool) -> bool {
    body.get(key).and_then(Value::as_bool).unwrap_or(default)
}

impl Service {
    pub fn new(cancellations: Cancellations, data_dir: Option<PathBuf>) -> Self {
        Self {
            cancellations,
            bus: None,
            activity: Activity::default(),
            cast_tried: false,
            sessions: HashMap::new(),
            resolved: HashMap::new(),
            cast: None,
            data_dir,
        }
    }

    async fn bus(&mut self) -> CuResult<Bus> {
        if let Some(bus) = &self.bus {
            return Ok(bus.clone());
        }
        let bus = Bus::connect().await?;
        self.activity.listen(&bus).await;
        self.bus = Some(bus.clone());
        Ok(bus)
    }

    /// The ScreenCast portal, for screenshots.
    async fn connect_cast(&mut self) {
        if !self.cast_tried {
            self.cast_tried = true;
            self.cast = ScreenCast::connect(self.data_dir.clone()).await;
        }
    }

    pub async fn handle(&mut self, body: &Map<String, Value>, check: &Checkpoint) -> CuResult<Value> {
        self.connect_cast().await;
        match body.get("op").and_then(Value::as_str).unwrap_or_default() {
            "hello" => {
                let accessibility = self.bus().await.is_ok();
                Ok(
                    json!({"version": 2, "accessibility": accessibility, "screenRecording": self.cast.is_some(), "capabilities": CAPABILITIES}),
                )
            }
            "apps" => self.apps(body.get("query").and_then(Value::as_str)).await,
            "resolve" => {
                let bus = self.bus().await?;
                let (installed, running) = self.catalog(&bus).await;
                let found = catalog::resolve(
                    body.get("app").and_then(Value::as_str).unwrap_or_default(),
                    &candidates(&running, &installed),
                )?;
                Ok(json!({"bundleId": found.id, "name": found.name, "running": found.running}))
            }
            "state" => self.state(body, check).await,
            "act" => self.act(body, check).await,
            _ => Err(CuError::new("bad_request", "Unknown op.")),
        }
    }

    async fn catalog(&self, bus: &Bus) -> (Vec<DesktopApp>, Vec<RunningApp>) {
        let installed = apps::installed();
        let running = apps::running(bus, &installed).await;
        (installed, running)
    }

    async fn apps(&mut self, query: Option<&str>) -> CuResult<Value> {
        let bus = self.bus().await?;
        let (installed, running) = self.catalog(&bus).await;
        let running_rows: Vec<Candidate> = running
            .iter()
            .map(|r| Candidate {
                id: r.id.clone(),
                name: r.name.clone(),
                running: true,
            })
            .collect();
        let installed_rows: Vec<Candidate> = installed
            .iter()
            .filter(|a| a.listed)
            .map(|a| Candidate {
                id: a.id.clone(),
                name: a.name.clone(),
                running: false,
            })
            .collect();
        let rows = catalog::listing(query, &running_rows, &installed_rows);
        Ok(json!({"apps": rows.iter().map(|row| {
            let mut entry = json!({"name": row.name, "bundleId": row.id, "running": row.running});
            if row.running {
                entry["active"] = json!(running.iter().any(|r| r.id == row.id && r.active));
            }
            entry
        }).collect::<Vec<_>>()}))
    }

    /// The session for the named app, launching it when allowed. True when it was launched.
    async fn session(&mut self, bus: &Bus, query: &str, launch: bool, check: &Checkpoint) -> CuResult<(u32, bool)> {
        let alive = |pid: u32| std::path::Path::new(&format!("/proc/{pid}")).exists();
        if let Some(pid) = self.resolved.get(query).copied() {
            if self.sessions.contains_key(&pid) && alive(pid) {
                return Ok((pid, false));
            }
        }
        let (installed, running) = self.catalog(bus).await;
        let found = catalog::resolve(query, &candidates(&running, &installed))?;
        let mut launched = false;
        let app = match running.iter().find(|r| r.id == found.id) {
            Some(app) => app.clone(),
            None => {
                let entry = installed.iter().find(|a| a.id == found.id).ok_or_else(|| {
                    CuError::new("app_not_found", format!("{query} is not running and not installed."))
                })?;
                if !launch {
                    return Err(CuError::new(
                        "app_not_running",
                        format!("{} is not running. Call screen_state to open it.", entry.name),
                    ));
                }
                apps::launch(entry)?;
                launched = true;
                self.wait_for_launch(bus, entry, &installed, check).await?
            }
        };
        self.sessions.retain(|pid, session| {
            alive(*pid) && (*pid == app.pid || session.last_used.elapsed() < Duration::from_secs(600))
        });
        self.resolved.retain(|_, pid| alive(*pid));
        self.resolved.insert(query.to_owned(), app.pid);
        self.sessions
            .entry(app.pid)
            .or_insert_with(|| AppSession::new(app.pid, app.obj.clone(), app.id.clone(), app.name.clone()));
        Ok((app.pid, launched))
    }

    async fn wait_for_launch(
        &self,
        bus: &Bus,
        entry: &DesktopApp,
        installed: &[DesktopApp],
        check: &Checkpoint,
    ) -> CuResult<RunningApp> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            check.check()?;
            tokio::time::sleep(Duration::from_millis(250)).await;
            let running = apps::running(bus, installed).await;
            if let Some(app) = running.into_iter().find(|r| r.id == entry.id) {
                return Ok(app);
            }
        }
        Err(CuError::new(
            "launch_failed",
            format!(
                "{} was started but no window appeared within 15 seconds (or it does not support accessibility). Call screen_state again in a moment.",
                entry.name
            ),
        ))
    }

    async fn state(&mut self, body: &Map<String, Value>, check: &Checkpoint) -> CuResult<Value> {
        let started = Instant::now();
        let bus = self.bus().await?;
        let (pid, launched) = self
            .session(
                &bus,
                body.get("app").and_then(Value::as_str).unwrap_or_default(),
                true,
                check,
            )
            .await?;
        let session = self
            .sessions
            .get_mut(&pid)
            .ok_or_else(|| CuError::new("app_not_found", "The app went away."))?;
        session.last_used = Instant::now();
        if launched {
            self.activity
                .settle(
                    session.bus_name(),
                    Duration::from_millis(300),
                    Duration::from_millis(200),
                    Duration::from_millis(2000),
                    check,
                )
                .await?;
        }
        check.check()?;
        let windows = session.choose_window(&bus, body.get("window")).await?;
        let options = Options {
            screenshot: flag(body, "screenshot", false),
            outline: flag(body, "outline", true),
            marks: flag(body, "marks", true),
        };
        let mut result = observe::observation(&bus, session, &windows, self.cast.as_mut(), &options).await;
        check.check()?;
        if launched {
            result["launched"] = json!(true);
        }
        result["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
        Ok(result)
    }

    async fn act(&mut self, body: &Map<String, Value>, check: &Checkpoint) -> CuResult<Value> {
        let started = Instant::now();
        let bus = self.bus().await?;
        let (pid, _) = self
            .session(
                &bus,
                body.get("app").and_then(Value::as_str).unwrap_or_default(),
                false,
                check,
            )
            .await?;
        let Self {
            sessions,
            activity,
            cast,
            ..
        } = self;
        let session = sessions
            .get_mut(&pid)
            .ok_or_else(|| CuError::new("app_not_found", "The app went away."))?;
        session.last_used = Instant::now();
        if session.window.is_none() || body.get("window").is_some() {
            session.choose_window(&bus, body.get("window")).await?;
        }
        if session.nodes.is_empty() {
            session.walk(&bus, None, Duration::from_secs(3)).await;
        }
        let before = session
            .windows(&bus)
            .await
            .into_iter()
            .find(|w| w.active)
            .map(|w| w.obj);
        let steps: Vec<Map<String, Value>> = body
            .get("actions")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|s| s.as_object().cloned()).collect())
            .unwrap_or_default();
        let mut done: Vec<String> = Vec::new();
        let mut failure = None;
        {
            let mut actor = Actor {
                bus: &bus,
                session: &mut *session,
                activity,
                check,
            };
            for (index, step) in steps.iter().enumerate() {
                let outcome = match check.check() {
                    Ok(()) => actor.run(step).await,
                    Err(error) => Err(error),
                };
                match outcome {
                    Ok(line) => done.push(line),
                    Err(error) => {
                        failure = Some(json!({"index": index, "code": error.code, "message": error.message}));
                        break;
                    }
                }
                if index + 1 < steps.len()
                    && let Err(error) = activity
                        .settle(
                            actor.session.bus_name(),
                            Duration::from_millis(40),
                            Duration::from_millis(100),
                            Duration::from_millis(1200),
                            check,
                        )
                        .await
                {
                    failure = Some(json!({"index": index + 1, "code": error.code, "message": error.message}));
                    break;
                }
            }
        }
        let mut result = json!({"done": done});
        if let Some(failure) = failure {
            result["error"] = failure;
        }
        if flag(body, "observe", true) && check.check().is_ok() {
            if !session.not_responding {
                activity
                    .settle(
                        session.bus_name(),
                        Duration::from_millis(60),
                        Duration::from_millis(150),
                        Duration::from_millis(2000),
                        check,
                    )
                    .await
                    .ok();
            }
            // Follow a window or dialog the steps opened.
            let windows = session.windows(&bus).await;
            if let Some(active) = windows.iter().find(|w| w.active) {
                if before.as_ref() != Some(&active.obj) {
                    session.window = Some(active.clone());
                    session.menu_bar = None;
                }
            }
            let windows = session.choose_window(&bus, None).await.unwrap_or(windows);
            let options = Options {
                screenshot: flag(body, "screenshot", false),
                outline: flag(body, "outline", true),
                marks: flag(body, "marks", true),
            };
            result["state"] = observe::observation(&bus, session, &windows, cast.as_mut(), &options).await;
        }
        result["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
        Ok(result)
    }
}

/// Running apps first, then every installed one.
fn candidates(running: &[RunningApp], installed: &[DesktopApp]) -> Vec<Candidate> {
    running
        .iter()
        .map(|r| Candidate {
            id: r.id.clone(),
            name: r.name.clone(),
            running: true,
        })
        .chain(installed.iter().map(|a| Candidate {
            id: a.id.clone(),
            name: a.name.clone(),
            running: false,
        }))
        .collect()
}
