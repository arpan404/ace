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
use crate::computer::person::{Outcome, Person};
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
    /// What each query named last, while its process lives.
    resolved: HashMap<String, RunningApp>,
    /// Wayland screenshots, through the ScreenCast portal.
    cast: Option<ScreenCast>,
    /// Where restore tokens are kept (`--data-dir`); without it they last for this process.
    data_dir: Option<PathBuf>,
    /// Keep-awake, the "ace is using" notice and the guard; connected on the first look.
    person: Option<Person>,
    /// `--lease-seconds`: the keep-awake lease, for tests.
    lease: Option<Duration>,
}

fn flag(body: &Map<String, Value>, key: &str, default: bool) -> bool {
    body.get(key).and_then(Value::as_bool).unwrap_or(default)
}

impl Service {
    pub fn new(cancellations: Cancellations, data_dir: Option<PathBuf>, lease: Option<Duration>) -> Self {
        Self {
            cancellations,
            bus: None,
            activity: Activity::default(),
            cast_tried: false,
            sessions: HashMap::new(),
            resolved: HashMap::new(),
            cast: None,
            data_dir,
            person: None,
            lease,
        }
    }

    async fn person(&mut self) -> &mut Person {
        if self.person.is_none() {
            self.person = Some(Person::connect(self.cancellations.stop.clone(), self.lease).await);
        }
        self.person.as_mut().expect("connected above")
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
                let person = self.person().await.facts().await;
                Ok(
                    json!({"version": 2, "accessibility": accessibility, "screenRecording": self.cast.is_some(), "capabilities": CAPABILITIES, "person": person}),
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
            op @ ("state" | "act") => {
                self.person().await;
                let result = if op == "act" {
                    self.act(body, check).await
                } else {
                    self.state(body, check).await
                };
                let code = match &result {
                    Err(error) => Some(error.code),
                    Ok(value) => value.pointer("/error/code").and_then(Value::as_str).map(|code| {
                        if code == "stopped_by_person" { "stopped_by_person" } else { "failed" }
                    }),
                };
                let outcome = match code {
                    Some("stopped_by_person") => Outcome::Stopped,
                    Some(_) => Outcome::Ended,
                    None if check.check().is_err() => Outcome::Ended,
                    None => Outcome::Continues,
                };
                self.person().await.end(outcome).await;
                result
            }
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
        if let Some(app) = self.resolved.get(query).cloned() {
            if let Some(session) = self.sessions.get_mut(&app.pid).filter(|_| alive(app.pid)) {
                follow_module(session, &app);
                return Ok((app.pid, false));
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
                if let Some(pid) = apps::inaccessible_process(entry, &installed) {
                    return Err(apps::inaccessible_error(entry, pid));
                }
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
        self.resolved.retain(|_, known| alive(known.pid));
        self.resolved.insert(query.to_owned(), app.clone());
        let session = self
            .sessions
            .entry(app.pid)
            .or_insert_with(|| AppSession::new(app.pid, app.obj.clone(), app.id.clone(), app.name.clone()));
        follow_module(session, &app);
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
        let mut marks = vec![("session", started.elapsed())];
        let name = self.sessions.get(&pid).map(|s| s.name.clone()).unwrap_or_default();
        let person = self.person().await;
        person.begin(&name, false).await;
        marks.push(("awake", started.elapsed()));
        let status = person.status().await;
        marks.push(("status", started.elapsed()));
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
        marks.push(("windows", started.elapsed()));
        if launched && crate::computer::chromium::is_chromium_process(std::path::Path::new("/proc"), session.pid) {
            // Chromium shows its window long before its pages and controls join the tree.
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(12) {
                session.walk(&bus, None, Duration::from_secs(1)).await;
                if session.nodes.len() > 8 {
                    break;
                }
                check.check()?;
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
        let options = Options {
            screenshot: flag(body, "screenshot", false),
            outline: flag(body, "outline", true),
            marks: flag(body, "marks", true),
        };
        let last_event = self.activity.last(session.bus_name());
        let mut result = observe::observation(&bus, session, &windows, self.cast.as_mut(), &options.for_status(status), last_event).await;
        marks.push(("observation", started.elapsed()));
        observe::mark_status(&mut result, status, &options);
        observe::mark_accessibility(&mut result, session.pid, &session.name);
        marks.push(("notes", started.elapsed()));
        if std::env::var_os("ACE_CU_TIMINGS").is_some() {
            result["timings"] = json!(marks.iter().map(|(name, at)| (name.to_string(), json!(at.as_millis() as u64))).collect::<Map<String, Value>>());
        }
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
        let name = self.sessions.get(&pid).map(|s| s.name.clone()).unwrap_or_default();
        self.person().await.begin(&name, true).await;
        let Self {
            sessions,
            activity,
            cast,
            person,
            ..
        } = self;
        let person = person.as_mut().ok_or_else(|| CuError::new("internal", "No person watch."))?;
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
                    Ok(()) => match person.check_step(&bus, actor.session, step).await {
                        Ok(()) => actor.run(step).await,
                        Err(error) => Err(error),
                    },
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
            let status = person.status().await;
            let last_event = activity.last(session.bus_name());
            let mut state = observe::observation(&bus, session, &windows, cast.as_mut(), &options.for_status(status), last_event).await;
            observe::mark_status(&mut state, status, &options);
            observe::mark_accessibility(&mut state, session.pid, &session.name);
            result["state"] = state;
        }
        result["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
        Ok(result)
    }
}

/// A suite's modules share one process: the session follows the module asked for.
fn follow_module(session: &mut AppSession, app: &RunningApp) {
    if session.title_hint != app.title_hint {
        session.title_hint = app.title_hint.clone();
        session.id = app.id.clone();
        session.name = app.name.clone();
        session.window = None;
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
