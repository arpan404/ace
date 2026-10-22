//! Depth-first walk of one window into outline nodes, with node, element and time budgets.
//! Hidden subtrees are skipped, unlabelled wrappers fold away, and the first unanswered call
//! ends the walk with a partial outline instead of hanging.
use crate::computer::bus::{Bus, BusError, Obj, key};
use crate::computer::element::{self, Element};
use crate::computer::error::clip;
use crate::computer::ids::Ids;
use crate::computer::outline::{self, Keep, Node, Rect};
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
}

#[derive(Default)]
pub struct Tree {
    pub nodes: Vec<Node>,
    pub truncated: bool,
    pub not_responding: bool,
    pub focused: Option<Focused>,
    pub menu_bar: Option<Obj>,
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
        self.visit(root.clone(), depth, true, None).await;
    }

    pub fn finish(self) -> Tree {
        self.ids.prune();
        self.tree
    }

    fn visit(
        &mut self,
        obj: Obj,
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
            let element = match element::read(self.bus, &obj).await {
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
            let children = match self.bus.children(&obj).await {
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
            let Some(node) = self.describe(&element, depth, children.len()).await else {
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
                        self.note_focus(&element, Some(node.id), node.name.clone(), &node.role)
                            .await;
                    }
                    self.tree.nodes.push(node);
                    depth + 1
                }
                Described::Fold => {
                    if element.states.focused {
                        self.note_focus(&element, None, None, &element.role.clone()).await;
                    }
                    depth
                }
                Described::Drop => return,
            };
            for child in children {
                if self.exhausted() {
                    self.tree.truncated = true;
                    break;
                }
                self.visit(child, child_depth, false, inherited.clone()).await;
            }
        })
    }

    async fn note_focus(&mut self, element: &Element, id: Option<u64>, name: Option<String>, role: &str) {
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
        });
    }

    /// Reads what the role can show and decides whether the element gets a line.
    async fn describe(&mut self, element: &Element, depth: usize, children: usize) -> Option<Described> {
        let role = element.role.as_str();
        let structural_only =
            matches!(role, "panel" | "grouping" | "filler" | "section" | "split pane" | "frame" | "window");
        let text_input = outline::is_text_input(role, &element.states);
        let wants_actions =
            element.interfaces.action && !matches!(role, "label" | "static" | "frame" | "window" | "dialog");
        let wants_text = element.interfaces.text
            && role != "password text"
            && (text_input
                || (element.name.trim().is_empty()
                    && matches!(role, "label" | "static" | "text" | "paragraph" | "heading" | "caption")));
        let bus = self.bus;
        let obj = &element.obj;
        let frames = self.frames;
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
