//! Depth-first walk of one window into outline nodes, with node, element and time budgets.
//! Hidden subtrees are skipped, unlabelled wrappers fold away, and the first unanswered call
//! ends the walk with a partial outline instead of hanging.
use crate::computer::bus::{Bus, BusError, BusResult, Obj, key};
use crate::computer::element::{self, Element};
use crate::computer::error::clip;
use crate::computer::ids::Ids;
use crate::computer::outline::{self, FocusClaim, Keep, Node, Rect};
use std::collections::HashSet;
use std::time::Instant;

const MAX_VISITED: usize = 6000;
const MAX_NODES: usize = 1200;
const MAX_CHILDREN: usize = 400;

/// How element extents become window pixels: which coordinate type to ask for and what to
/// subtract.
#[derive(Clone, Copy, Debug)]
pub struct FrameMap {
    pub coord: u32,
    pub dx: f64,
    pub dy: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Focused {
    pub id: Option<u64>,
    pub obj: Option<Obj>,
    pub role: String,
    pub name: Option<String>,
    pub selected_text: Option<String>,
    pub claim: FocusClaim,
}

#[derive(Clone, Default)]
pub struct Tree {
    pub nodes: Vec<Node>,
    pub truncated: bool,
    pub not_responding: bool,
    pub focused: Option<Focused>,
    pub menu_bar: Option<Obj>,
}

/// What was true when a window was last walked, for `still_current`.
#[derive(Clone, Debug, PartialEq)]
pub struct WalkStamp {
    pub at: Instant,
    /// When the app last reported a change (or the helper changed it), as of the walk.
    pub last_event: Option<Instant>,
    /// The walked window.
    pub window: Option<String>,
    /// Whether element frames were read.
    pub framed: bool,
}

/// How long a walk may be reused when nothing has changed: apps that change without telling
/// accessibility are covered by this short limit (as on macOS).
pub const REUSE_FOR: std::time::Duration = std::time::Duration::from_secs(2);

/// Whether a look can reuse the last walk: within `REUSE_FOR`, the app sent no event and the
/// helper did nothing since, and it is the same window read the same way.
pub fn still_current(last: &WalkStamp, now: &WalkStamp) -> bool {
    now.at >= last.at
        && now.at - last.at <= REUSE_FOR
        && last.last_event == now.last_event
        && last.window == now.window
        && last.framed == now.framed
}

pub struct Walker<'a> {
    bus: &'a Bus,
    ids: &'a mut Ids<String, Obj>,
    frames: Option<FrameMap>,
    deadline: Instant,
    seen: HashSet<String>,
    visited: usize,
    pub tree: Tree,
}

impl<'a> Walker<'a> {
    pub fn new(bus: &'a Bus, ids: &'a mut Ids<String, Obj>, frames: Option<FrameMap>, deadline: Instant) -> Self {
        ids.begin_walk();
        Self {
            bus,
            ids,
            frames,
            deadline,
            seen: HashSet::new(),
            visited: 0,
            tree: Tree::default(),
        }
    }

    fn exhausted(&self) -> bool {
        self.tree.not_responding
            || self.visited >= MAX_VISITED
            || self.tree.nodes.len() >= MAX_NODES
            || Instant::now() > self.deadline
    }

    pub async fn walk(&mut self, root: &Obj, depth: usize) {
        let read = element::read(self.bus, root).await;
        let children = self.bus.children(root).await;
        self.visit(root.clone(), read, children, None, depth, true, None).await;
    }

    pub fn finish(mut self) -> Tree {
        self.ids.prune();
        // Only the element that has the focus says so; see `outline::focus_outranks`.
        if let Some(id) = self.tree.focused.as_ref().and_then(|focused| focused.id) {
            for node in self.tree.nodes.iter_mut().filter(|node| node.id != id) {
                node.flags.retain(|flag| flag != "focused");
            }
        }
        self.tree
    }

    /// One element, read already with its children list: siblings are read together, so a
    /// window costs about one round of calls per level rather than per element.
    fn visit(
        &mut self,
        obj: Obj,
        read: BusResult<Element>,
        children: BusResult<Vec<Obj>>,
        prefetched_facts: Option<Facts>,
        depth: usize,
        root: bool,
        parent_name: Option<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + '_>> {
        Box::pin(async move {
            if self.exhausted() {
                self.tree.truncated = true;
                return;
            }
            if !self.seen.insert(key(&obj)) {
                return;
            }
            self.visited += 1;
            let element = match read {
                Ok(element) => element,
                Err(BusError::Timeout) => {
                    self.tree.not_responding = true;
                    self.tree.truncated = true;
                    return;
                }
                Err(_) => return,
            };
            if element.defunct || (!root && !element.states.showing) || outline::is_noise(&element.role) {
                return;
            }
            if element.role == "menu bar" {
                self.tree.menu_bar.get_or_insert(obj);
                return;
            }
            let children = match children {
                Ok(mut children) => {
                    if children.len() > MAX_CHILDREN {
                        children.truncate(MAX_CHILDREN);
                        self.tree.truncated = true;
                    }
                    children
                }
                Err(BusError::Timeout) => {
                    self.tree.not_responding = true;
                    return;
                }
                Err(_) => Vec::new(),
            };
            let element_facts = match prefetched_facts {
                Some(found) => found,
                None => facts(self.bus, &element, self.frames).await,
            };
            let Some(node) = self.describe(&element, element_facts, depth, children.len()) else {
                return;
            };
            let mut inherited = parent_name.clone();
            let child_depth = match node {
                Described::Line(node) => {
                    let mut node = *node;
                    node.depth = depth;
                    // A caption that repeats its control's name (a button's own label) says nothing.
                    let caption = matches!(element.role.as_str(), "label" | "static" | "text") && !node.actionable;
                    if caption && children.is_empty() && node.name.is_some() && node.name == parent_name {
                        return;
                    }
                    if node.name.is_some() {
                        inherited = node.name.clone();
                    }
                    if element.states.focused {
                        self.note_focus(&element, depth, Some(node.id), node.name.clone(), &node.role)
                            .await;
                    }
                    self.tree.nodes.push(node);
                    depth + 1
                }
                Described::Fold => {
                    if element.states.focused {
                        self.note_focus(&element, depth, None, None, &element.role.clone()).await;
                    }
                    depth
                }
                Described::Drop => return,
            };
            let bus = self.bus;
            let frames = self.frames;
            let prefetched = futures_util::future::join_all(children.iter().map(|child| async move {
                let (read, grandchildren) = tokio::join!(element::read(bus, child), bus.children(child));
                let shown = read
                    .as_ref()
                    .ok()
                    .filter(|e| !e.defunct && e.states.showing && !outline::is_noise(&e.role) && e.role != "menu bar");
                let found = match shown {
                    Some(element) => Some(facts(bus, element, frames).await),
                    None => None,
                };
                (read, grandchildren, found)
            }))
            .await;
            for (child, (read, grandchildren, found)) in children.into_iter().zip(prefetched) {
                if self.exhausted() {
                    self.tree.truncated = true;
                    break;
                }
                self.visit(child, read, grandchildren, found, child_depth, false, inherited.clone()).await;
            }
        })
    }

    async fn note_focus(&mut self, element: &Element, depth: usize, id: Option<u64>, name: Option<String>, role: &str) {
        let claim = FocusClaim {
            text_input: outline::is_text_input(&element.role, &element.states),
            line: id.is_some(),
            depth,
        };
        if let Some(current) = &self.tree.focused {
            if !outline::focus_outranks(claim, current.claim) {
                return;
            }
        }
        let mut selected_text = None;
        if element.interfaces.text && element.role != "password text" {
            if let Some((start, end)) = element::selection(self.bus, &element.obj).await {
                selected_text = element::text(self.bus, &element.obj, start, end.min(start + 2000))
                    .await
                    .ok()
                    .and_then(|t| clip(&t, 500));
            }
        }
        self.tree.focused = Some(Focused {
            id,
            obj: Some(element.obj.clone()),
            role: role.to_owned(),
            name,
            selected_text,
            claim,
        });
    }

    /// Decides from what was read whether the element gets a line.
    fn describe(&mut self, element: &Element, facts: Facts, depth: usize, children: usize) -> Option<Described> {
        let role = element.role.as_str();
        let structural_only = is_structural_only(role);
        let text_input = outline::is_text_input(role, &element.states);
        let frames = self.frames;
        let obj = &element.obj;
        let Facts {
            actions,
            frame,
            text,
            value,
            attributes,
        } = facts;
        let actions = actions.unwrap_or_default();
        let actionable = outline::is_actionable(role, &element.states, &actions);
        let text_value = text.map(|(text, count)| {
            let shown = clip(&text, 2000).unwrap_or_default();
            if count > 2000 {
                format!("{shown}…({count} chars)")
            } else {
                shown
            }
        });
        let value = if structural_only {
            None
        } else if text_input {
            text_value.or(Some(String::new())).filter(|_| role != "password text")
        } else {
            text_value.or_else(|| value.map(format_number))
        };
        let (name, value, detail) = outline::texts(
            role,
            clip(&element.name, 200),
            clip(&element.description, 200),
            value.filter(|v| !v.is_empty() || text_input),
        );
        let labelled = name.is_some() || value.as_ref().is_some_and(|v| !v.is_empty());
        if matches!(role, "label" | "static") && !labelled {
            return Some(Described::Drop);
        }
        match outline::keep(role, actionable && !structural_only, labelled, children) {
            Keep::Drop => return Some(Described::Drop),
            Keep::Fold => return Some(Described::Fold),
            Keep::Line => {}
        }
        let fingerprint = matches!(role, "list item" | "table cell" | "tree item")
            .then(|| format!("{role}|{}", name.clone().unwrap_or_default()));
        let id = self.ids.id(&key(obj), obj.clone(), fingerprint);
        let frame = frame.zip(frames).map(|(r, map)| Rect {
            x: r.x - map.dx,
            y: r.y - map.dy,
            w: r.w,
            h: r.h,
        });
        let placeholder = attributes.and_then(|a| a.get("placeholder-text").and_then(|p| clip(p, 120)));
        Some(Described::Line(Box::new(Node {
            id,
            depth,
            role: outline::role_name(role, &element.states, false),
            flags: outline::flags(role, &element.states),
            name,
            value: value.filter(|v| !v.is_empty()),
            detail,
            placeholder,
            actions: outline::readable_actions(role, &actions),
            frame,
            actionable: actionable && !structural_only,
        })))
    }
}

fn is_structural_only(role: &str) -> bool {
    matches!(role, "panel" | "grouping" | "filler" | "section" | "split pane" | "frame" | "window")
}

/// What the role can show, read for one element: its actions, frame, text, value and attributes.
pub struct Facts {
    actions: Option<Vec<String>>,
    frame: Option<Rect>,
    text: Option<(String, i32)>,
    value: Option<f64>,
    attributes: Option<std::collections::HashMap<String, String>>,
}

/// The calls `describe` needs, run together; free of the walker so siblings run them at once.
pub async fn facts(bus: &Bus, element: &Element, frames: Option<FrameMap>) -> Facts {
    let role = element.role.as_str();
    let text_input = outline::is_text_input(role, &element.states);
    let wants_actions =
        element.interfaces.action && !matches!(role, "label" | "static" | "frame" | "window" | "dialog");
    let wants_text = element.interfaces.text
        && role != "password text"
        && (text_input
            || (element.name.trim().is_empty()
                && matches!(role, "label" | "static" | "text" | "paragraph" | "heading" | "caption")));
    let obj = &element.obj;
    let (actions, frame, text, value, attributes) = tokio::join!(
            async {
                if wants_actions {
                    element::action_names(bus, obj).await.ok()
                } else {
                    None
                }
            },
            async {
                match (frames, element.interfaces.component) {
                    (Some(map), true) => element::extents(bus, obj, map.coord).await.ok().flatten(),
                    _ => None,
                }
            },
            async {
                if wants_text {
                    element::text_head(bus, obj, 2000).await.ok()
                } else {
                    None
                }
            },
            async {
                if element.interfaces.value {
                    element::current_value(bus, obj).await.ok()
                } else {
                    None
                }
            },
            async {
                if text_input {
                    Some(element::attributes(bus, obj).await)
                } else {
                    None
                }
            },
    );
    Facts {
        actions,
        frame,
        text,
        value,
        attributes,
    }
}

enum Described {
    Line(Box<Node>),
    Fold,
    Drop,
}

pub fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[cfg(test)]
mod reuse_tests {
    use super::*;

    #[test]
    fn a_look_reuses_the_last_walk_only_while_nothing_can_have_changed() {
        let start = Instant::now();
        let event = start - std::time::Duration::from_secs(5);
        let walked = WalkStamp {
            at: start,
            last_event: Some(event),
            window: Some("w".into()),
            framed: false,
        };
        let later = |seconds: f64| WalkStamp {
            at: start + std::time::Duration::from_secs_f64(seconds),
            ..walked.clone()
        };
        assert!(still_current(&walked, &later(1.0)));
        // Too old: an app may have changed without saying so.
        assert!(!still_current(&walked, &later(2.5)));
        // The app reported a change, or the helper acted.
        assert!(!still_current(&walked, &WalkStamp { last_event: Some(start), ..later(0.5) }));
        // Another window, or now with frames for a screenshot.
        assert!(!still_current(&walked, &WalkStamp { window: Some("x".into()), ..later(0.5) }));
        assert!(!still_current(&walked, &WalkStamp { framed: true, ..later(0.5) }));
    }
}
