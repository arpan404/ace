//! Reading a window as outline nodes. The whole control-view subtree comes in one cached UI
//! Automation request; a window too large or slow for that is walked one element at a time
//! until a deadline. Ids stay stable through `Ids`, keyed by runtime id.
use super::ids::Ids;
use super::outline::{self, control, Keep, Node, Rect};
use super::uia::{self, Uia};
use std::time::{Duration, Instant};
use windows::Win32::{Foundation::HWND, UI::Accessibility::IUIAutomationElement};

pub const MAX_LINES: usize = 1200;
const MAX_VISITED: usize = 6000;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Focus {
    pub id: Option<u64>,
    pub role: String,
    pub name: Option<String>,
}

#[derive(Default)]
pub struct Walked {
    pub nodes: Vec<Node>,
    pub focus: Option<Focus>,
    pub truncated: bool,
    /// The app did not answer in time; the outline may be partial.
    pub timed_out: bool,
    /// Elements visited, to choose the step-by-step walk next time for very large windows.
    pub visited: usize,
}

struct Walker<'a> {
    uia: &'a Uia,
    ids: &'a mut Ids<String, IUIAutomationElement>,
    origin: (f64, f64),
    deadline: Instant,
    cached: bool,
    out: Walked,
}

impl Walker<'_> {
    fn children(&self, element: &IUIAutomationElement) -> Vec<IUIAutomationElement> {
        if self.cached {
            uia::cached_children(element)
        } else {
            uia::live_children(self.uia, element)
        }
    }

    fn visit(
        &mut self,
        element: &IUIAutomationElement,
        depth: usize,
        parent: Option<&str>,
        in_menu_bar: bool,
    ) {
        if self.out.nodes.len() >= MAX_LINES
            || self.out.visited >= MAX_VISITED
            || Instant::now() >= self.deadline
        {
            self.out.truncated = true;
            return;
        }
        self.out.visited += 1;
        let mut facts = uia::facts(element);
        facts.in_menu_bar = in_menu_bar;
        if outline::is_noise(facts.control_type) {
            return;
        }
        // A caption repeating its control's name says nothing new.
        if facts.control_type == control::TEXT
            && parent.is_some()
            && facts.name.as_deref() == parent
        {
            return;
        }
        let children = self.children(element);
        let actionable = outline::is_actionable(&facts);
        let (name, value, detail) = outline::texts(&facts);
        let labelled = name.is_some() || value.is_some();
        match outline::keep(facts.control_type, actionable, labelled, children.len()) {
            Keep::Drop => {}
            Keep::Fold => {
                for child in &children {
                    self.visit(child, depth, parent, in_menu_bar);
                }
            }
            Keep::Line => {
                let key = uia::runtime_id(element)
                    .unwrap_or_else(|| format!("walk.{}.{}", depth, self.out.visited));
                let id = self
                    .ids
                    .id(&key, element.clone(), outline::fingerprint(&facts));
                let role = outline::role_name(&facts).to_owned();
                if facts.focused {
                    self.out.focus = Some(Focus {
                        id: Some(id),
                        role: role.clone(),
                        name: name.clone(),
                    });
                }
                let frame = uia::frame(element)
                    .filter(|_| !uia::offscreen(element))
                    .map(|r| Rect {
                        x: r.x - self.origin.0,
                        y: r.y - self.origin.1,
                        ..r
                    });
                self.out.nodes.push(Node {
                    id,
                    depth,
                    role,
                    flags: outline::flags(&facts),
                    name: name.clone(),
                    value,
                    detail,
                    placeholder: None,
                    actions: outline::readable_actions(&facts),
                    frame,
                    actionable,
                });
                let menu_bar = facts.control_type == control::MENU_BAR;
                for child in &children {
                    self.visit(child, depth + 1, name.as_deref(), menu_bar);
                }
            }
        }
    }
}

/// Walks `hwnd`'s control view. `origin` is the window frame's top-left on the screen; node
/// frames are measured from it. `large` asks for the step-by-step walk straight away.
pub fn walk(
    uia: &Uia,
    ids: &mut Ids<String, IUIAutomationElement>,
    hwnd: HWND,
    origin: (f64, f64),
    budget: Duration,
    large: bool,
) -> Walked {
    let deadline = Instant::now() + budget;
    ids.begin_walk();
    let mut timed_out = false;
    let mut root = None;
    if !large {
        match unsafe { uia.api.ElementFromHandleBuildCache(hwnd, &uia.tree) } {
            Ok(element) => root = Some((element, true)),
            Err(error) => timed_out = uia::is_timeout(&error),
        }
    }
    // Too large or slow for one request: step by step, within what is left of the budget.
    if root.is_none() {
        root = unsafe { uia.api.ElementFromHandleBuildCache(hwnd, &uia.one) }
            .ok()
            .map(|element| (element, false));
    }
    let Some((root, cached)) = root else {
        return Walked {
            timed_out,
            ..Walked::default()
        };
    };
    let mut walker = Walker {
        uia,
        ids,
        origin,
        deadline,
        cached,
        out: Walked {
            timed_out,
            ..Walked::default()
        },
    };
    walker.visit(&root, 0, None, false);
    let mut out = walker.out;
    if !cached && Instant::now() >= deadline {
        out.timed_out = out.timed_out || out.nodes.is_empty();
    }
    ids.prune();
    out
}
