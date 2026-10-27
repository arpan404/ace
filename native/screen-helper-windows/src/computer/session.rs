//! What the engine keeps per app between requests: the window it is looking at, stable ids for
//! that app's elements, the last outline, where the agent last focused, and how the last
//! screenshot maps to the screen.
use super::apps::TopWindow;
use super::error::{CuError, CuResult};
use super::geometry::Shot;
use super::ids::Ids;
use super::outline::{self, Node};
use super::uia::Uia;
use super::walk::{self, Focus, Known};
use serde_json::Value;
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::HWND,
    UI::{Accessibility::IUIAutomationElement, WindowsAndMessaging::*},
};

pub struct AppSession {
    pub id: String,
    pub name: String,
    pub window: Option<HWND>,
    pub ids: Ids<String, Known>,
    pub nodes: Vec<Node>,
    pub truncated: bool,
    pub not_responding: bool,
    /// The window was too large for one cached read last time.
    pub large: bool,
    pub focus: Option<Focus>,
    /// An element the agent focused while the window was in the background: typing and keys
    /// without an id go to it.
    pub agent_focus: Option<u64>,
    pub shot: Option<(HWND, Shot)>,
    pub last_used: Instant,
}

impl AppSession {
    pub fn new(id: String, name: String) -> Self {
        Self {
            id,
            name,
            window: None,
            ids: Ids::default(),
            nodes: Vec::new(),
            truncated: false,
            not_responding: false,
            large: false,
            focus: None,
            agent_focus: None,
            shot: None,
            last_used: Instant::now(),
        }
    }

    pub fn windows<'a>(&self, all: &'a [TopWindow]) -> Vec<&'a TopWindow> {
        all.iter()
            .filter(|w| w.app.eq_ignore_ascii_case(&self.id))
            .collect()
    }

    pub fn pids(&self, all: &[TopWindow]) -> Vec<u32> {
        let mut pids: Vec<u32> = Vec::new();
        for window in self.windows(all) {
            if !pids.contains(&window.pid) {
                pids.push(window.pid);
            }
        }
        pids
    }

    fn set_window(&mut self, window: Option<HWND>) {
        if self.window != window {
            self.window = window;
            // Ids belong to the window they were read in; old ones stop resolving.
            self.ids.clear();
            self.nodes.clear();
            self.shot = None;
            self.agent_focus = None;
            self.focus = None;
            self.large = false;
            self.not_responding = false;
        }
    }

    /// Picks the window to look at: the one asked for (number or part of the title), else the
    /// current one while it exists, else the front-most one that is not minimized.
    pub fn choose(&mut self, all: &[TopWindow], wanted: Option<&Value>) -> CuResult<()> {
        let mine = self.windows(all);
        let listing = || {
            mine.iter()
                .enumerate()
                .map(|(i, w)| format!("{} \"{}\"", i + 1, w.title))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let chosen = match wanted {
            Some(Value::Number(number)) => {
                let index = number.as_u64().unwrap_or(0) as usize;
                Some(
                    mine.get(index.wrapping_sub(1))
                        .ok_or_else(|| {
                            CuError::new(
                                "window_not_found",
                                format!(
                                    "{} has no window {index}. Its windows: {}.",
                                    self.name,
                                    listing()
                                ),
                            )
                        })?
                        .hwnd,
                )
            }
            Some(Value::String(title)) => {
                let wanted = title.trim().to_lowercase();
                Some(
                    mine.iter()
                        .find(|w| w.title.to_lowercase().contains(&wanted))
                        .ok_or_else(|| {
                            CuError::new(
                                "window_not_found",
                                format!(
                                    "{} has no window titled \"{title}\". Its windows: {}.",
                                    self.name,
                                    listing()
                                ),
                            )
                        })?
                        .hwnd,
                )
            }
            _ => self
                .window
                .filter(|current| mine.iter().any(|w| w.hwnd == *current))
                .or_else(|| mine.iter().find(|w| !w.minimized).map(|w| w.hwnd))
                .or_else(|| mine.first().map(|w| w.hwnd)),
        };
        self.set_window(chosen);
        Ok(())
    }

    /// Switches to a window that just appeared (a dialog the steps opened).
    pub fn follow(&mut self, hwnd: HWND) {
        self.set_window(Some(hwnd));
    }

    pub fn hwnd(&self) -> CuResult<HWND> {
        self.window
            .filter(|hwnd| unsafe { IsWindow(*hwnd) }.as_bool())
            .ok_or_else(|| {
                CuError::new(
                    "no_window",
                    format!(
                        "{} has no open window. Look again (screen_state) after opening one.",
                        self.name
                    ),
                )
            })
    }

    pub fn node(&self, id: u64) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// `12 button "Save"`, or `element 12` for an id from an earlier look.
    pub fn label(&self, id: u64) -> String {
        self.node(id)
            .map(Node::label)
            .unwrap_or_else(|| format!("element {id}"))
    }

    /// The element behind an id, checked again before acting: it must be in the window it was
    /// read in, and still be the same control (same kind, row and name). Otherwise the id is
    /// stale and nothing acts on whatever took its place.
    pub fn element(&self, uia: &Uia, id: u64) -> CuResult<IUIAutomationElement> {
        let stale = |what: String| {
            CuError::new(
                "stale_element",
                format!("Element {id} {what}. Look again (screen_state) and use the new ids."),
            )
        };
        let known = self.ids.get(id).cloned().ok_or_else(|| {
            stale(format!(
                "is not in {}'s window any more (or is from another look)",
                self.name
            ))
        })?;
        if Some(known.window) != self.window.map(|w| w.0 as isize) {
            return Err(stale("is from another window".into()));
        }
        let fresh = uia.refresh(&known.element).map_err(|error| {
            // An app that does not answer is busy, not changed.
            if error.code == "app_busy" {
                error
            } else {
                stale(format!("is gone from {}'s window", self.name))
            }
        })?;
        let facts = super::uia::facts(&fresh);
        let row = super::uia::row_of(uia, &known.element);
        if outline::identity(&facts, row.as_deref()) != known.identity {
            let now = facts
                .name
                .as_deref()
                .and_then(|n| super::error::clip(n, 60))
                .map(|n| format!(" (it now shows \"{n}\")"))
                .unwrap_or_default();
            return Err(stale(format!("changed since your last look{now}")));
        }
        Ok(known.element)
    }

    /// Reads the chosen window's outline again.
    pub fn walk(&mut self, uia: &Uia, budget: Duration) {
        let Ok(hwnd) = self.hwnd() else {
            self.nodes.clear();
            return;
        };
        if unsafe { IsHungAppWindow(hwnd) }.as_bool() {
            self.not_responding = true;
            self.nodes.clear();
            return;
        }
        let origin = super::capture::frame(hwnd).map_or((0.0, 0.0), |f| (f.x, f.y));
        let walked = walk::walk(uia, &mut self.ids, hwnd, origin, budget, self.large);
        self.large = walked.visited > 3000 || walked.timed_out;
        self.not_responding = walked.timed_out && walked.nodes.len() < 2;
        self.truncated = walked.truncated;
        self.nodes = walked.nodes;
        self.focus = walked.focus;
        if self
            .agent_focus
            .is_some_and(|id| !self.nodes.iter().any(|n| n.id == id))
        {
            self.agent_focus = None;
        }
    }
}
