//! How AT-SPI elements become outline nodes: role names, flags, listed actions and which
//! elements are worth a line. Pure, so the rules are tested without a desktop.
use serde_json::{Value, json};

/// What the walker read of one element, reduced to what the outline rules need.
#[derive(Clone, Debug, Default)]
pub struct States {
    pub focused: bool,
    pub selected: bool,
    pub checked: bool,
    pub pressed: bool,
    pub indeterminate: bool,
    pub checkable: bool,
    pub expanded: bool,
    pub expandable: bool,
    pub collapsed: bool,
    pub sensitive: bool,
    pub enabled: bool,
    pub showing: bool,
    pub editable: bool,
    pub multi_line: bool,
    pub iconified: bool,
    pub active: bool,
    pub focusable: bool,
    pub selectable: bool,
}

/// How strongly a focused element claims the keyboard focus.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FocusClaim {
    /// It takes typed text.
    pub text_input: bool,
    /// It has an outline line (not a folded wrapper).
    pub line: bool,
    pub depth: usize,
}

/// Whether `new` is the element with the focus rather than `current`, both reported focused.
/// Qt reports every widget whose focus proxy has the focus as focused too (KTextEditor's
/// status-bar buttons proxy the editor), so several elements claim it: a text input beats
/// anything else, a line beats a folded wrapper, an element inside the other wins, and
/// otherwise the first in document order stays.
pub fn focus_outranks(new: FocusClaim, current: FocusClaim) -> bool {
    let rank = |claim: FocusClaim| (claim.text_input, claim.line);
    rank(new) > rank(current) || rank(new) == rank(current) && new.depth > current.depth
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = (self.x + self.w).min(other.x + other.w);
        let bottom = (self.y + self.h).min(other.y + other.h);
        (right > x && bottom > y).then_some(Rect {
            x,
            y,
            w: right - x,
            h: bottom - y,
        })
    }
}

/// What to subtract from window-relative extents to get X window pixels, given the window's
/// content box: the content sits centred in the X window (GTK4 surrounds it with an even
/// shadow margin), so its left edge lands at half the spare width.
pub fn content_offset(window: (f64, f64), content: Rect) -> (f64, f64) {
    let margin = |outer: f64, inner: f64| ((outer - inner) / 2.0).max(0.0);
    (
        content.x - margin(window.0, content.w),
        content.y - margin(window.1, content.h),
    )
}

/// One outline line.
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub id: u64,
    pub depth: usize,
    pub role: String,
    pub flags: Vec<String>,
    pub name: Option<String>,
    pub value: Option<String>,
    pub detail: Option<String>,
    pub placeholder: Option<String>,
    pub actions: Vec<String>,
    /// Where it is in window pixels, for screenshot marks.
    pub frame: Option<Rect>,
    /// Whether a click by id does something; marks only tag these.
    pub actionable: bool,
}

impl Node {
    pub fn json(&self) -> Value {
        let mut object = json!({"id": self.id, "depth": self.depth, "role": self.role});
        if !self.flags.is_empty() {
            object["flags"] = json!(self.flags);
        }
        for (key, value) in [
            ("name", &self.name),
            ("value", &self.value),
            ("detail", &self.detail),
            ("placeholder", &self.placeholder),
        ] {
            if let Some(value) = value {
                object[key] = json!(value);
            }
        }
        if !self.actions.is_empty() {
            object["actions"] = json!(self.actions);
        }
        object
    }

    /// The words a text condition searches: role, name, value, detail and placeholder.
    pub fn search_line(&self) -> String {
        [
            Some(&self.role),
            self.name.as_ref(),
            self.value.as_ref(),
            self.detail.as_ref(),
            self.placeholder.as_ref(),
        ]
        .into_iter()
        .flatten()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
    }

    /// `12 button "Save"`: how steps name the element they acted on.
    pub fn label(&self) -> String {
        match &self.name {
            Some(name) => format!(
                "{} {} \"{}\"",
                self.id,
                self.role,
                crate::computer::error::clip(name, 60).unwrap_or_default()
            ),
            None => format!("{} {}", self.id, self.role),
        }
    }
}

/// Elements that take typed text.
pub fn is_text_input(role: &str, states: &States) -> bool {
    matches!(role, "entry" | "password text" | "spin button" | "terminal" | "editbar")
        || (role == "text" && states.editable)
        || (role == "combo box" && states.editable)
}

/// Chrome that restates what scrolling and layout already show. Skipped with everything inside,
/// so never a container of content: a split pane (Qt's QSplitter, GTK's GtkPaned) holds the
/// app's views and folds like any other wrapper instead.
pub fn is_noise(role: &str) -> bool {
    matches!(role, "scroll bar" | "separator" | "tool tip" | "redundant object" | "invalid")
}

/// Containers kept even without a label, so their contents stay visibly grouped.
fn is_structural(role: &str) -> bool {
    matches!(
        role,
        "frame"
            | "dialog"
            | "alert"
            | "file chooser"
            | "window"
            | "menu"
            | "popup menu"
            | "table"
            | "tree table"
            | "tree"
            | "list"
            | "list box"
            | "page tab list"
            | "tool bar"
            | "document web"
            | "document frame"
            | "scroll pane"
            | "page tab"
            | "menu bar"
    )
}

/// Roles that are worth acting on even when they list no action.
fn always_actionable(role: &str) -> bool {
    matches!(
        role,
        "check box"
            | "radio button"
            | "toggle button"
            | "combo box"
            | "slider"
            | "spin button"
            | "link"
            | "page tab"
            | "list item"
            | "table cell"
            | "tree item"
            | "menu item"
            | "check menu item"
            | "radio menu item"
            | "push button"
            | "button"
            | "switch"
    )
}

/// Action names that are the element's plain click.
pub fn is_press_action(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "click" | "press" | "activate" | "default.activate" | "toggle" | "jump" | "open" | "select"
    )
}

/// The index of the action a click by id performs: press-like names, in preference order.
pub fn press_action(actions: &[String]) -> Option<usize> {
    for wanted in [
        "click",
        "press",
        "activate",
        "toggle",
        "jump",
        "open",
        "select",
        "default.activate",
    ] {
        if let Some(index) = actions.iter().position(|a| a.eq_ignore_ascii_case(wanted)) {
            return Some(index);
        }
    }
    None
}

/// The model-facing role name. AT-SPI names mostly read well; a few are renamed to the words
/// the macOS engine uses so instructions carry over.
pub fn role_name(role: &str, states: &States, in_menu_bar: bool) -> String {
    let name = match role {
        "push button" => "button",
        "label" | "static" | "paragraph" | "caption" => "text",
        "frame" => "window",
        "panel" | "grouping" | "filler" | "section" | "form" | "block quote" | "landmark" => "group",
        "scroll pane" => "scroll area",
        "page tab" => "tab",
        "page tab list" => "tab group",
        "tool bar" => "toolbar",
        "document web" | "document frame" => "web area",
        "password text" => "secure text field",
        "entry" => "text field",
        "text" if states.editable && states.multi_line => "text area",
        "text" if states.editable => "text field",
        "text" => "text",
        "table cell" => "cell",
        "tree item" | "list item" => "row",
        "menu" if in_menu_bar => "menu bar item",
        "toggle button" => "toggle button",
        other => other,
    };
    name.to_owned()
}

pub fn flags(role: &str, states: &States) -> Vec<String> {
    let mut flags = Vec::new();
    // GTK4 never sets ENABLED; SENSITIVE is what every toolkit sets on usable controls.
    if !states.sensitive {
        flags.push("disabled");
    }
    if states.selected && !matches!(role, "frame" | "dialog" | "window") {
        flags.push("selected");
    }
    if states.focused {
        flags.push("focused");
    }
    if states.expandable || states.expanded {
        flags.push(if states.expanded { "expanded" } else { "collapsed" });
    }
    if role == "password text" {
        flags.push("secure");
    }
    let toggles = matches!(
        role,
        "check box" | "radio button" | "toggle button" | "switch" | "check menu item" | "radio menu item"
    );
    if toggles {
        flags.push(if states.indeterminate {
            "mixed"
        } else if states.checked || states.pressed {
            "on"
        } else {
            "off"
        });
    }
    flags.into_iter().map(str::to_owned).collect()
}

/// The actions listed on a line: the element's own beyond its plain click, at most six.
/// Windows and plain containers list none (GTK4 hangs every window action off them).
pub fn readable_actions(role: &str, actions: &[String]) -> Vec<String> {
    if matches!(
        role,
        "frame"
            | "dialog"
            | "window"
            | "panel"
            | "grouping"
            | "filler"
            | "label"
            | "section"
            | "application"
            | "scroll pane"
    ) {
        return Vec::new();
    }
    let mut readable: Vec<String> = Vec::new();
    for action in actions {
        if is_press_action(action) || action.is_empty() || action.chars().count() > 40 {
            continue;
        }
        if !readable.iter().any(|a| a == action) && readable.len() < 6 {
            readable.push(action.clone());
        }
    }
    readable
}

/// What the element is worth: a line of its own, folded into its only child, or dropped.
#[derive(Debug, PartialEq, Eq)]
pub enum Keep {
    Line,
    Fold,
    Drop,
}

pub fn keep(role: &str, actionable: bool, labelled: bool, children: usize) -> Keep {
    if actionable || labelled || is_structural(role) {
        return Keep::Line;
    }
    // GTK4 nests every control in several unnamed boxes; a line for each costs tokens and
    // says nothing, so plain containers always fold into their children.
    let plain = matches!(role, "panel" | "grouping" | "filler" | "section" | "generic" | "split pane");
    match children {
        0 => Keep::Drop,
        1 => Keep::Fold,
        _ if plain => Keep::Fold,
        _ => Keep::Line,
    }
}

pub fn is_actionable(role: &str, states: &States, actions: &[String]) -> bool {
    press_action(actions).is_some() || is_text_input(role, states) || always_actionable(role)
}

/// Name, value and detail as the line shows them: text roles carry their words as the name,
/// and nothing is said twice.
pub fn texts(
    role: &str,
    name: Option<String>,
    description: Option<String>,
    value: Option<String>,
) -> (Option<String>, Option<String>, Option<String>) {
    let mut name = name;
    let mut value = value;
    let mut detail = description;
    if name.is_none() && detail.is_some() && !matches!(role, "text" | "entry") {
        name = detail.take();
    }
    if matches!(role, "label" | "static" | "paragraph" | "caption" | "heading") && name.is_none() {
        name = value.take();
    }
    if value.is_some() && value == name {
        value = None;
    }
    if detail.is_some() && detail == name {
        detail = None;
    }
    (name, value, detail)
}

#[cfg(test)]
#[path = "outline_tests.rs"]
mod tests;
