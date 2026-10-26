//! The ops: `hello`, `apps`, `resolve`, `state` and `act`, one at a time on the worker thread.
use super::act::Actor;
use super::apps::{self, Identities, RunningApp, TopWindow};
use super::cancel::Checkpoint;
use super::catalog::{self, executable_id, Candidate};
use super::clipboard::Clipboard;
use super::desktop::{self, PersonWatch};
use super::error::{CuError, CuResult};
use super::known::Known;
use super::observe::{self, Options};
use super::session::AppSession;
use super::settle::Activity;
use super::shell::{self, StartApp};
use super::timing;
use super::uia::Uia;
use super::wire::flag;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const CAPABILITIES: [&str; 20] = [
    "click",
    "move",
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
    "drag",
    "window",
    "wait",
    "wait_for",
    "activate",
    "cancel",
    "outline_off",
    "when",
];

/// An app as a request names it, resolved.
struct Resolved {
    id: String,
    name: String,
    running: bool,
    /// What starts it: `shell:AppsFolder\…` or an executable path.
    launch: Option<String>,
}

pub struct Service {
    uia: Option<Uia>,
    sessions: HashMap<String, AppSession>,
    start: Option<(Instant, Vec<StartApp>)>,
    names: HashMap<String, String>,
    known: Known,
    injected: Option<u32>,
    clipboard: Option<Clipboard>,
}

fn looks_like_path(query: &str) -> bool {
    query.contains('\\') || query.contains('/')
}

impl Service {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            uia: None,
            sessions: HashMap::new(),
            start: None,
            names: HashMap::new(),
            known: Known::new(data_dir.as_deref()),
            injected: None,
            clipboard: None,
        }
    }

    pub fn shutdown(&mut self) {
        if let Some(clipboard) = self.clipboard.as_mut() {
            clipboard.restore();
        }
    }

    fn uia(&mut self) -> CuResult<&Uia> {
        if self.uia.is_none() {
            self.uia = Some(Uia::new()?);
        }
        self.uia
            .as_ref()
            .ok_or_else(|| CuError::new("internal", "UI Automation is unavailable."))
    }

    pub fn handle(&mut self, body: &Map<String, Value>, check: &Checkpoint) -> CuResult<Value> {
        match body.get("op").and_then(Value::as_str).unwrap_or_default() {
            "hello" => {
                let accessibility = self.uia().is_ok();
                Ok(json!({
                    "version": 2,
                    "platform": "windows",
                    "accessibility": accessibility,
                    "screenRecording": true,
                    "capabilities": CAPABILITIES,
                }))
            }
            "apps" => self.apps(body.get("query").and_then(Value::as_str)),
            "resolve" => {
                let found =
                    self.resolve(body.get("app").and_then(Value::as_str).unwrap_or_default())?;
                Ok(json!({"bundleId": found.id, "name": found.name, "running": found.running}))
            }
            "state" => self.state(body, check),
            "act" => self.act(body, check),
            _ => Err(CuError::new("bad_request", "Unknown op.")),
        }
    }

    fn start_apps(&mut self) -> &[StartApp] {
        let stale = self
            .start
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(60));
        if stale {
            self.start = Some((Instant::now(), shell::start_apps()));
        }
        self.start
            .as_ref()
            .map(|(_, apps)| apps.as_slice())
            .unwrap_or(&[])
    }

    fn name_of(&mut self, id: &str, path: Option<&str>) -> String {
        if let Some(app) = self
            .start_apps()
            .iter()
            .find(|a| a.id.eq_ignore_ascii_case(id))
        {
            return app.name.clone();
        }
        self.names
            .entry(id.to_lowercase())
            .or_insert_with(|| apps::fallback_name(id, path))
            .clone()
    }

    fn candidates(&mut self, running: &[RunningApp]) -> Vec<Candidate> {
        let mut candidates: Vec<Candidate> = running
            .iter()
            .map(|r| Candidate {
                id: r.id.clone(),
                name: self.name_of(&r.id, r.path.as_deref()),
                running: true,
            })
            .collect();
        candidates.extend(self.start_apps().iter().map(|a| Candidate {
            id: a.id.clone(),
            name: a.name.clone(),
            running: false,
        }));
        candidates
    }

    fn apps(&mut self, query: Option<&str>) -> CuResult<Value> {
        let (_, running) = desktop_apps();
        let all = self.candidates(&running);
        let (live, installed): (Vec<Candidate>, Vec<Candidate>) =
            all.into_iter().partition(|c| c.running);
        let rows = catalog::listing(query, &live, &installed);
        Ok(json!({"apps": rows.iter().map(|row| {
            let mut entry = json!({"name": row.name, "bundleId": row.id, "running": row.running});
            if row.running {
                entry["active"] = json!(running.iter().any(|r| r.id.eq_ignore_ascii_case(&row.id) && r.active));
            }
            entry
        }).collect::<Vec<_>>()}))
    }

    /// Names an app: a running or Start menu app by name or id, or an executable by path or
    /// by a file name Windows can find.
    fn resolve(&mut self, query: &str) -> CuResult<Resolved> {
        let query = query.trim();
        let (_, running) = desktop_apps();
        if looks_like_path(query) {
            let path = Path::new(query);
            if !query.to_lowercase().ends_with(".exe") || !path.is_file() {
                return Err(CuError::new(
                    "app_not_found",
                    format!("{query} is not an executable file. Name an app, or pass the full path of an .exe."),
                ));
            }
            let id = executable_id(query);
            if catalog::is_system_component(&id) {
                return Err(CuError::new(
                    "app_not_allowed",
                    catalog::system_component_message(query),
                ));
            }
            self.known.remember(&id, query);
            return Ok(Resolved {
                running: running.iter().any(|r| r.id.eq_ignore_ascii_case(&id)),
                name: self.name_of(&id, Some(query)),
                id,
                launch: Some(query.to_owned()),
            });
        }
        let candidates = self.candidates(&running);
        let found = match catalog::resolve(query, &candidates) {
            Ok(found) => found,
            Err(error)
                if error.code == "app_not_found" && query.to_lowercase().ends_with(".exe") =>
            {
                let path = search_path(query).ok_or(error)?;
                let id = executable_id(&path);
                self.known.remember(&id, &path);
                return Ok(Resolved {
                    name: self.name_of(&id, Some(&path)),
                    id,
                    running: false,
                    launch: Some(path),
                });
            }
            Err(error) => return Err(error),
        };
        let launch = self
            .start_apps()
            .iter()
            .find(|a| a.id.eq_ignore_ascii_case(&found.id))
            .map(|a| format!("shell:AppsFolder\\{}", a.parsing))
            .or_else(|| self.known.path(&found.id))
            .or_else(|| {
                running
                    .iter()
                    .find(|r| r.id.eq_ignore_ascii_case(&found.id))
                    .and_then(|r| r.path.clone())
            })
            .or_else(|| {
                found
                    .id
                    .ends_with(".exe")
                    .then(|| search_path(&found.id))
                    .flatten()
            });
        Ok(Resolved {
            id: found.id,
            name: found.name,
            running: found.running,
            launch,
        })
    }

    /// The session for the app, starting it when allowed. True when it was started.
    fn open(&mut self, query: &str, launch: bool, check: &Checkpoint) -> CuResult<(String, bool)> {
        let found = self.resolve(query)?;
        let key = found.id.to_lowercase();
        let mut launched = false;
        if !found.running {
            if !launch {
                return Err(CuError::new(
                    "app_not_running",
                    format!(
                        "{} is not running. Call screen_state to open it.",
                        found.name
                    ),
                ));
            }
            let target = found.launch.clone().ok_or_else(|| {
                CuError::new(
                    "app_not_found",
                    format!("{} is not running, and ace doesn't know how to start it. Pass the full path of its .exe.", found.name),
                )
            })?;
            shell::launch(target, found.name.clone())?;
            launched = true;
            self.wait_for_window(&found, check)?;
        }
        self.sessions.retain(|id, session| {
            *id == key || session.last_used.elapsed() < Duration::from_secs(600)
        });
        let session = self
            .sessions
            .entry(key.clone())
            .or_insert_with(|| AppSession::new(found.id.clone(), found.name.clone()));
        session.last_used = Instant::now();
        Ok((key, launched))
    }

    fn wait_for_window(&mut self, found: &Resolved, check: &Checkpoint) -> CuResult<()> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            check.check()?;
            std::thread::sleep(Duration::from_millis(200));
            let (windows, _) = desktop_apps();
            if windows
                .iter()
                .any(|w| w.app.eq_ignore_ascii_case(&found.id))
            {
                return Ok(());
            }
        }
        Err(CuError::new(
            "launch_failed",
            format!("{} was started, but no window appeared within 15 seconds. Call screen_state again in a moment.", found.name),
        ))
    }

    /// Refuses an app Windows shields from ace (it runs as administrator).
    fn reachable(session: &AppSession, windows: &[TopWindow]) -> CuResult<()> {
        let pid = session
            .window
            .and_then(|hwnd| windows.iter().find(|w| w.hwnd == hwnd))
            .map(|w| w.pid);
        match pid {
            Some(pid) if desktop::elevated_above_us(pid) => {
                Err(desktop::elevated_error(&session.name))
            }
            _ => Ok(()),
        }
    }

    fn state(&mut self, body: &Map<String, Value>, check: &Checkpoint) -> CuResult<Value> {
        let started = Instant::now();
        self.uia()?;
        let app = body.get("app").and_then(Value::as_str).unwrap_or_default();
        let (key, launched) = self.open(app, true, check)?;
        let (windows, _) = desktop_apps();
        let Self { uia, sessions, .. } = self;
        let uia = uia
            .as_ref()
            .ok_or_else(|| CuError::new("internal", "UI Automation is unavailable."))?;
        let session = sessions
            .get_mut(&key)
            .ok_or_else(|| CuError::new("app_not_found", "The app went away."))?;
        if launched {
            let mut activity = Activity::watch(&session.pids(&windows));
            activity.begin();
            activity.settle(&timing::AFTER_LAUNCH, check)?;
        }
        check.check()?;
        session.choose(&windows, body.get("window"))?;
        Self::reachable(session, &windows)?;
        let options = Options {
            screenshot: flag(body, "screenshot", false),
            outline: flag(body, "outline", true),
            marks: flag(body, "marks", true),
        };
        let mut result = observe::observation(uia, session, &windows, &options);
        check.check()?;
        if launched {
            result["launched"] = json!(true);
        }
        result["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
        Ok(result)
    }

    fn act(&mut self, body: &Map<String, Value>, check: &Checkpoint) -> CuResult<Value> {
        let started = Instant::now();
        self.uia()?;
        let app = body.get("app").and_then(Value::as_str).unwrap_or_default();
        let (key, _) = self.open(app, false, check)?;
        let (windows, _) = desktop_apps();
        let Self {
            uia,
            sessions,
            injected,
            clipboard,
            ..
        } = self;
        let uia = uia
            .as_ref()
            .ok_or_else(|| CuError::new("internal", "UI Automation is unavailable."))?;
        let session = sessions
            .get_mut(&key)
            .ok_or_else(|| CuError::new("app_not_found", "The app went away."))?;
        if session.window.is_none() || body.get("window").is_some() {
            session.choose(&windows, body.get("window"))?;
        } else {
            session.choose(&windows, None)?;
        }
        Self::reachable(session, &windows)?;
        if session.nodes.is_empty() {
            session.walk(uia, Duration::from_secs(3));
        }
        let before: Vec<_> = session.windows(&windows).iter().map(|w| w.hwnd).collect();
        let pids = session.pids(&windows);
        let steps: Vec<Map<String, Value>> = body
            .get("actions")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|s| s.as_object().cloned()).collect())
            .unwrap_or_default();
        let mut activity = Activity::watch(&pids);
        let person = PersonWatch::start();
        let mut done: Vec<String> = Vec::new();
        let mut failure = None;
        {
            let mut actor = Actor {
                uia,
                session: &mut *session,
                activity: &mut activity,
                check,
                person: &person,
                injected,
                clipboard,
                pids: pids.clone(),
            };
            for (index, step) in steps.iter().enumerate() {
                actor.activity.begin();
                let outcome = match check.check() {
                    Ok(()) => actor.run(step),
                    Err(error) => Err(error),
                };
                match outcome {
                    Ok(line) => done.push(line),
                    Err(error) => {
                        failure = Some(
                            json!({"index": index, "code": error.code, "message": error.message}),
                        );
                        break;
                    }
                }
                if index + 1 < steps.len() {
                    if let Err(error) = actor.activity.settle(&timing::BETWEEN_STEPS, check) {
                        failure = Some(
                            json!({"index": index + 1, "code": error.code, "message": error.message}),
                        );
                        break;
                    }
                }
            }
        }
        drop(person);
        let mut result = json!({"done": done});
        if let Some(failure) = failure {
            result["error"] = failure;
        }
        if flag(body, "observe", true) && check.check().is_ok() {
            let _ = activity.settle(&timing::BEFORE_LOOK, check);
            let (now, _) = desktop_apps();
            // Follow a window or dialog the steps opened.
            if let Some(opened) = session
                .windows(&now)
                .into_iter()
                .find(|w| !before.contains(&w.hwnd) && !w.minimized)
            {
                session.follow(opened.hwnd);
            }
            let _ = session.choose(&now, None);
            let options = Options {
                screenshot: flag(body, "screenshot", false),
                outline: flag(body, "outline", true),
                marks: flag(body, "marks", true),
            };
            result["state"] = observe::observation(uia, session, &now, &options);
        }
        drop(activity);
        result["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
        Ok(result)
    }
}

/// The desktop's app windows and the running apps they belong to.
fn desktop_apps() -> (Vec<TopWindow>, Vec<RunningApp>) {
    let windows = apps::top_windows(&mut Identities::default());
    let running = apps::running(&windows);
    (windows, running)
}

/// An executable Windows can find by name: the app paths registered in the registry, then the
/// search path.
fn search_path(name: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::SearchPathW;
    let name = name.trim();
    for root in [
        windows::Win32::System::Registry::HKEY_CURRENT_USER,
        windows::Win32::System::Registry::HKEY_LOCAL_MACHINE,
    ] {
        let key = HSTRING::from(format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{name}"
        ));
        let mut buffer = vec![0u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        let read = unsafe {
            windows::Win32::System::Registry::RegGetValueW(
                root,
                &key,
                None,
                windows::Win32::System::Registry::RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if read.is_ok() {
            let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
            let path = String::from_utf16_lossy(&buffer[..end])
                .trim_matches('"')
                .to_owned();
            if Path::new(&path).is_file() {
                return Some(path);
            }
        }
    }
    let mut buffer = vec![0u16; 1024];
    let length =
        unsafe { SearchPathW(None, &HSTRING::from(name), None, Some(&mut buffer), None) } as usize;
    (length > 0 && length < buffer.len()).then(|| String::from_utf16_lossy(&buffer[..length]))
}
