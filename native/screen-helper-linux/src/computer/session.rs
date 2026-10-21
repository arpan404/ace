//! One app the agent works in: its windows, the chosen window, stable ids and the last walk.
use crate::computer::bus::{Bus, BusError, Obj, key};
use crate::computer::element::{self, COORD_SCREEN, COORD_WINDOW};
use crate::computer::error::{CuError, CuResult};
use crate::computer::ids::Ids;
use crate::computer::outline::Node;
use crate::computer::walk::{FrameMap, Tree, Walker};
use crate::computer::xdisplay::XDisplay;
use serde_json::Value;
use std::collections::HashSet;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct WindowEntry {
    pub obj: Obj,
    pub index: usize,
    pub title: String,
    pub minimized: bool,
    pub active: bool,
    pub showing: bool,
}

pub struct AppSession {
    pub pid: u32,
    pub app: Obj,
    pub id: String,
    pub name: String,
    pub ids: Ids<String, Obj>,
    pub window: Option<WindowEntry>,
    pub nodes: Vec<Node>,
    pub focused: Option<crate::computer::walk::Focused>,
    pub menu_bar: Option<Obj>,
    pub not_responding: bool,
    /// X windows already redirected for capture.
    pub redirected: HashSet<u32>,
    /// Screenshot pixels per window pixel in the last screenshot; maps x,y steps.
    pub scale: f64,
    pub last_used: Instant,
}

const WINDOW_ROLES: [&str; 5] = ["frame", "dialog", "alert", "file chooser", "window"];

impl AppSession {
    pub fn new(pid: u32, app: Obj, id: String, name: String) -> Self {
        Self {
            pid,
            app,
            id,
            name,
            ids: Ids::default(),
            window: None,
            nodes: Vec::new(),
            focused: None,
            menu_bar: None,
            not_responding: false,
            redirected: HashSet::new(),
            scale: 1.0,
            last_used: Instant::now(),
        }
    }

    pub fn bus_name(&self) -> &str {
        &self.app.0
    }

    /// The app's top-level windows, numbered from 1 in the app's own order.
    pub async fn windows(&mut self, bus: &Bus) -> Vec<WindowEntry> {
        let children = match bus.children(&self.app).await {
            Ok(children) => children,
            Err(error) => {
                self.not_responding = error.is_timeout();
                return Vec::new();
            }
        };
        let reads = futures_util::future::join_all(children.iter().map(|child| element::read(bus, child))).await;
        let mut windows = Vec::new();
        for read in reads {
            let element = match read {
                Ok(element) => element,
                Err(BusError::Timeout) => {
                    self.not_responding = true;
                    continue;
                }
                Err(_) => continue,
            };
            if element.defunct || !WINDOW_ROLES.contains(&element.role.as_str()) {
                continue;
            }
            // GTK lists popovers, menus and tooltips as unnamed "window" children.
            if element.role == "window" && (element.name.trim().is_empty() || !element.states.showing) {
                continue;
            }
            windows.push(WindowEntry {
                index: windows.len() + 1,
                obj: element.obj,
                title: element.name,
                minimized: element.states.iconified,
                active: element.states.active,
                showing: element.states.showing,
            });
        }
        windows
    }

    /// Keeps the chosen window while it exists; otherwise the active, then a visible one.
    pub async fn choose_window(&mut self, bus: &Bus, selector: Option<&Value>) -> CuResult<Vec<WindowEntry>> {
        self.not_responding = false;
        let all = self.windows(bus).await;
        let listed = || {
            all.iter()
                .map(|w| format!("{} \"{}\"", w.index, w.title))
                .collect::<Vec<_>>()
                .join(", ")
        };
        if let Some(number) = selector.and_then(Value::as_u64) {
            let found = all.iter().find(|w| w.index as u64 == number).ok_or_else(|| {
                CuError::new(
                    "window_not_found",
                    if all.is_empty() {
                        format!("{} has no open window.", self.name)
                    } else {
                        format!("{} has no window {number}; its windows are {}.", self.name, listed())
                    },
                )
            })?;
            self.window = Some(found.clone());
            return Ok(all);
        }
        if let Some(title) = selector.and_then(Value::as_str).filter(|t| !t.is_empty()) {
            let wanted = title.to_lowercase();
            let found = all
                .iter()
                .find(|w| w.title.to_lowercase().contains(&wanted))
                .ok_or_else(|| {
                    CuError::new(
                        "window_not_found",
                        format!(
                            "No {} window title contains \"{title}\". Windows: {}.",
                            self.name,
                            listed()
                        ),
                    )
                })?;
            self.window = Some(found.clone());
            return Ok(all);
        }
        let current = self.window.as_ref().and_then(|w| all.iter().find(|e| e.obj == w.obj));
        self.window = current
            .or_else(|| all.iter().find(|w| w.active))
            .or_else(|| all.iter().find(|w| w.showing && !w.minimized))
            .or_else(|| all.first())
            .cloned();
        Ok(all)
    }

    /// The X window showing the chosen accessible window.
    pub fn x_window(&self, x: &XDisplay) -> Option<u32> {
        let window = self.window.as_ref()?;
        x.window_for(self.pid, &window.title)
    }

    /// How extents map to window pixels. Toolkits that know their screen position (GTK3, Qt)
    /// report screen coordinates; GTK4 reports window-relative ones only.
    pub async fn frame_map(&self, bus: &Bus, x: &XDisplay, xid: u32) -> Option<FrameMap> {
        let window = self.window.as_ref()?;
        let (wx, wy, ww, wh) = x.geometry(xid)?;
        let screen = element::extents(bus, &window.obj, COORD_SCREEN).await.ok().flatten();
        if let Some(frame) = screen {
            let near = (frame.x - f64::from(wx)).abs() < 96.0 && (frame.y - f64::from(wy)).abs() < 96.0;
            if near && !(frame.x == 0.0 && frame.y == 0.0 && (wx, wy) != (0, 0)) {
                return Some(FrameMap {
                    coord: COORD_SCREEN,
                    dx: f64::from(wx),
                    dy: f64::from(wy),
                });
            }
        }
        let relative = element::extents(bus, &window.obj, COORD_WINDOW).await.ok().flatten()?;
        // The frame's window extents cover the whole X window, shadow included.
        let dx = if (relative.w - f64::from(ww)).abs() < 2.0 {
            relative.x
        } else {
            0.0
        };
        let dy = if (relative.h - f64::from(wh)).abs() < 2.0 {
            relative.y
        } else {
            0.0
        };
        Some(FrameMap {
            coord: COORD_WINDOW,
            dx,
            dy,
        })
    }

    /// Walks the chosen window and any open popup windows, updating ids and the node list.
    pub async fn walk(&mut self, bus: &Bus, frames: Option<FrameMap>, budget: Duration) -> Tree {
        let deadline = Instant::now() + budget;
        let Some(window) = self.window.clone() else {
            self.nodes.clear();
            return Tree::default();
        };
        let popups = self.popups(bus, &window.obj).await;
        let mut walker = Walker::new(bus, &mut self.ids, frames, deadline);
        walker.walk(&window.obj, 0).await;
        for popup in popups {
            walker.walk(&popup, 0).await;
        }
        let tree = walker.finish();
        self.nodes = tree.nodes.clone();
        self.focused = tree.focused.clone();
        if tree.menu_bar.is_some() {
            self.menu_bar = tree.menu_bar.clone();
        }
        self.not_responding |= tree.not_responding;
        tree
    }

    /// App-level menus and popovers that are open now, outside the window.
    async fn popups(&self, bus: &Bus, window: &Obj) -> Vec<Obj> {
        let Ok(children) = bus.children(&self.app).await else {
            return Vec::new();
        };
        let mut open = Vec::new();
        for child in children.into_iter().filter(|c| c != window) {
            if let Ok(element) = element::read(bus, &child).await {
                let popup =
                    matches!(element.role.as_str(), "window" | "menu" | "popup menu") && element.name.trim().is_empty();
                if popup && element.states.showing && !element.defunct {
                    open.push(child);
                }
            }
        }
        open
    }

    /// The live element behind an id from an earlier look.
    pub async fn element(&self, bus: &Bus, id: u64) -> CuResult<element::Element> {
        let obj = self.ids.get(id).cloned().ok_or_else(|| {
            CuError::new(
                "stale_element",
                format!(
                    "Element {id} is no longer in {}. Observe again and use a current id.",
                    self.name
                ),
            )
        })?;
        match element::read(bus, &obj).await {
            Ok(element) if !element.defunct => Ok(element),
            Err(BusError::Timeout) => Err(CuError::new(
                "app_busy",
                format!(
                    "{} did not answer (it may be busy or showing a modal dialog). Observe before retrying.",
                    self.name
                ),
            )),
            _ => Err(CuError::new(
                "stale_element",
                format!("Element {id} went away (the UI changed). Observe again and use a current id."),
            )),
        }
    }

    /// `12 button "Save"` for the element an id names, from the last walk.
    pub fn label(&self, id: u64) -> String {
        self.nodes
            .iter()
            .find(|n| n.id == id)
            .map(Node::label)
            .unwrap_or_else(|| format!("{id}"))
    }

    pub fn label_of(&self, obj: &Obj) -> Option<String> {
        let id = self.ids.existing(&key(obj))?;
        Some(self.label(id))
    }
}
