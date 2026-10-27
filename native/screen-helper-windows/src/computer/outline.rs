//! How UI Automation elements become outline lines: role names, flags, listed actions and which
//! elements are worth a line. Pure, so the rules are tested without a desktop. Roles use the
//! words the macOS engine uses, so instructions carry over between platforms.
use serde_json::{json, Value};

/// UI Automation control type ids (UIA_*ControlTypeId), stable across Windows versions.
pub mod control {
    pub const BUTTON: i32 = 50000;
    pub const CALENDAR: i32 = 50001;
    pub const CHECK_BOX: i32 = 50002;
    pub const COMBO_BOX: i32 = 50003;
    pub const EDIT: i32 = 50004;
    pub const HYPERLINK: i32 = 50005;
    pub const IMAGE: i32 = 50006;
    pub const LIST_ITEM: i32 = 50007;
    pub const LIST: i32 = 50008;
    pub const MENU: i32 = 50009;
    pub const MENU_BAR: i32 = 50010;
    pub const MENU_ITEM: i32 = 50011;
    pub const PROGRESS_BAR: i32 = 50012;
    pub const RADIO_BUTTON: i32 = 50013;
    pub const SCROLL_BAR: i32 = 50014;
    pub const SLIDER: i32 = 50015;
    pub const SPINNER: i32 = 50016;
    pub const STATUS_BAR: i32 = 50017;
    pub const TAB: i32 = 50018;
    pub const TAB_ITEM: i32 = 50019;
    pub const TEXT: i32 = 50020;
    pub const TOOL_BAR: i32 = 50021;
    pub const TOOL_TIP: i32 = 50022;
    pub const TREE: i32 = 50023;
    pub const TREE_ITEM: i32 = 50024;
    pub const CUSTOM: i32 = 50025;
    pub const GROUP: i32 = 50026;
    pub const THUMB: i32 = 50027;
    pub const DATA_GRID: i32 = 50028;
    pub const DATA_ITEM: i32 = 50029;
    pub const DOCUMENT: i32 = 50030;
    pub const SPLIT_BUTTON: i32 = 50031;
    pub const WINDOW: i32 = 50032;
    pub const PANE: i32 = 50033;
    pub const HEADER: i32 = 50034;
    pub const HEADER_ITEM: i32 = 50035;
    pub const TABLE: i32 = 50036;
    pub const TITLE_BAR: i32 = 50037;
    pub const SEPARATOR: i32 = 50038;
    pub const SEMANTIC_ZOOM: i32 = 50039;
    pub const APP_BAR: i32 = 50040;
}

/// ToggleState and ExpandCollapseState values.
pub const TOGGLE_ON: i32 = 1;
pub const TOGGLE_INDETERMINATE: i32 = 2;
pub const EXPANDED: i32 = 1;
pub const PARTIALLY_EXPANDED: i32 = 2;
pub const LEAF: i32 = 3;

/// What the walker read of one element, reduced to what the outline rules need.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    pub control_type: i32,
    pub name: Option<String>,
    pub help: Option<String>,
    /// The Value pattern's value; never read for password fields.
    pub value: Option<String>,
    pub enabled: bool,
    pub focused: bool,
    pub password: bool,
    pub focusable: bool,
    pub invoke: bool,
    /// ToggleState when the element toggles.
    pub toggle: Option<i32>,
    /// ExpandCollapseState when the element expands.
    pub expand: Option<i32>,
    /// Whether it is selected, when it is a selectable item.
    pub selected: Option<bool>,
    /// Whether its value is writable, when it has the Value pattern.
    pub value_writable: Option<bool>,
    pub range_value: bool,
    pub text: bool,
    pub scroll: bool,
    pub scroll_item: bool,
    /// The legacy (MSAA) default action, such as "Press", "Open" or "Double Click".
    pub default_action: Option<String>,
    pub multi_line: bool,
    pub dialog: bool,
    pub in_menu_bar: bool,
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

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
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
    /// Where it is in physical pixels from the window's top-left corner, for marks and x,y hits.
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
                super::error::clip(name, 60).unwrap_or_default()
            ),
            None => format!("{} {}", self.id, self.role),
        }
    }
}

/// Elements that take typed text.
pub fn is_text_input(facts: &Facts) -> bool {
    match facts.control_type {
        control::EDIT => true,
        control::DOCUMENT | control::COMBO_BOX => facts.value_writable == Some(true),
        _ => false,
    }
}

/// Chrome that restates what scrolling and layout already show. Skipped with everything inside.
/// The title bar holds only the caption buttons and system menu; `window` steps cover them.
pub fn is_noise(control_type: i32) -> bool {
    matches!(
        control_type,
        control::SCROLL_BAR
            | control::SEPARATOR
            | control::TOOL_TIP
            | control::THUMB
            | control::TITLE_BAR
    )
}

/// Containers kept even without a label, so their contents stay visibly grouped.
fn is_structural(control_type: i32) -> bool {
    matches!(
        control_type,
        control::WINDOW
            | control::MENU
            | control::MENU_BAR
            | control::LIST
            | control::TREE
            | control::TABLE
            | control::DATA_GRID
            | control::TAB
            | control::TOOL_BAR
            | control::DOCUMENT
            | control::APP_BAR
            | control::STATUS_BAR
    )
}

/// Roles that are worth acting on even when they expose no pattern.
fn always_actionable(control_type: i32) -> bool {
    matches!(
        control_type,
        control::BUTTON
            | control::CHECK_BOX
            | control::RADIO_BUTTON
            | control::COMBO_BOX
            | control::SLIDER
            | control::SPINNER
            | control::HYPERLINK
            | control::TAB_ITEM
            | control::LIST_ITEM
            | control::TREE_ITEM
            | control::DATA_ITEM
            | control::MENU_ITEM
            | control::SPLIT_BUTTON
            | control::HEADER_ITEM
    )
}

/// Legacy default actions that are the element's plain click.
pub fn is_press_action(name: &str) -> bool {
    matches!(
        name.trim().to_lowercase().as_str(),
        "click"
            | "press"
            | "push"
            | "activate"
            | "toggle"
            | "check"
            | "uncheck"
            | "select"
            | "jump"
            | "execute"
            | "switch"
            | "expand"
            | "collapse"
            | "open"
            | "close"
    )
}

pub fn is_actionable(facts: &Facts) -> bool {
    facts.invoke
        || facts.toggle.is_some()
        || facts.selected.is_some()
        || facts.expand.is_some_and(|state| state != LEAF)
        || facts.value_writable == Some(true)
        || facts
            .default_action
            .as_deref()
            .is_some_and(|action| !action.trim().is_empty())
        || is_text_input(facts)
        || always_actionable(facts.control_type)
}

/// The model-facing role name.
pub fn role_name(facts: &Facts) -> &'static str {
    match facts.control_type {
        control::BUTTON => "button",
        control::CALENDAR => "calendar",
        control::CHECK_BOX => "check box",
        control::COMBO_BOX => "combo box",
        control::EDIT if facts.password => "secure text field",
        control::EDIT if facts.multi_line => "text area",
        control::EDIT => "text field",
        control::HYPERLINK => "link",
        control::IMAGE => "image",
        control::LIST_ITEM | control::DATA_ITEM | control::TREE_ITEM => "row",
        control::LIST => "list",
        control::MENU => "menu",
        control::MENU_BAR => "menu bar",
        control::MENU_ITEM if facts.in_menu_bar => "menu bar item",
        control::MENU_ITEM => "menu item",
        control::PROGRESS_BAR => "progress bar",
        control::RADIO_BUTTON => "radio button",
        control::SCROLL_BAR => "scroll bar",
        control::SLIDER => "slider",
        control::SPINNER => "spin button",
        control::STATUS_BAR => "status bar",
        control::TAB => "tab group",
        control::TAB_ITEM => "tab",
        control::TEXT => "text",
        control::TOOL_BAR | control::APP_BAR => "toolbar",
        control::TOOL_TIP => "tooltip",
        control::TREE => "outline",
        control::DATA_GRID | control::TABLE => "table",
        control::DOCUMENT if facts.value_writable == Some(true) => "text area",
        control::DOCUMENT => "document",
        control::SPLIT_BUTTON => "menu button",
        control::WINDOW if facts.dialog => "dialog",
        control::WINDOW => "window",
        control::HEADER => "header",
        control::HEADER_ITEM => "column header",
        control::TITLE_BAR => "title bar",
        control::SEPARATOR => "separator",
        _ => "group",
    }
}

pub fn flags(facts: &Facts) -> Vec<String> {
    let mut flags = Vec::new();
    if !facts.enabled {
        flags.push("disabled");
    }
    if facts.selected == Some(true) {
        flags.push("selected");
    }
    if facts.focused {
        flags.push("focused");
    }
    match facts.expand {
        Some(EXPANDED) => flags.push("expanded"),
        Some(LEAF) | None => {}
        Some(_) => flags.push("collapsed"),
    }
    if facts.password {
        flags.push("secure");
    }
    if is_text_input(facts) && facts.value_writable == Some(false) && !facts.password {
        flags.push("read-only");
    }
    if let Some(state) = facts.toggle {
        flags.push(match state {
            TOGGLE_ON => "on",
            TOGGLE_INDETERMINATE => "mixed",
            _ => "off",
        });
    }
    flags.into_iter().map(str::to_owned).collect()
}

/// The actions listed on a line: what the element does beyond its plain click, at most six.
pub fn readable_actions(facts: &Facts) -> Vec<String> {
    if matches!(
        facts.control_type,
        control::WINDOW | control::PANE | control::GROUP | control::CUSTOM | control::TEXT
    ) {
        return Vec::new();
    }
    let mut actions: Vec<String> = Vec::new();
    let mut add = |name: &str| {
        if !name.is_empty()
            && name.chars().count() <= 40
            && !actions.iter().any(|a| a.eq_ignore_ascii_case(name))
            && actions.len() < 6
        {
            actions.push(name.to_owned());
        }
    };
    match facts.expand {
        Some(EXPANDED) => add("collapse"),
        Some(LEAF) | None => {}
        Some(_) => add("expand"),
    }
    if facts.invoke && facts.selected.is_some() {
        add("select");
    }
    if facts.invoke && facts.toggle.is_some() {
        add("toggle");
    }
    if let Some(action) = facts.default_action.as_deref() {
        if !is_press_action(action) {
            add(&action.trim().to_lowercase());
        }
    }
    actions
}

/// What the element is worth: a line of its own, folded into its children, or dropped.
#[derive(Debug, PartialEq, Eq)]
pub enum Keep {
    Line,
    Fold,
    Drop,
}

pub fn keep(control_type: i32, actionable: bool, labelled: bool, children: usize) -> Keep {
    if actionable || labelled || is_structural(control_type) {
        return Keep::Line;
    }
    // Win32, WPF and WinUI nest controls in unnamed panes; a line for each says nothing.
    let plain = matches!(
        control_type,
        control::PANE | control::GROUP | control::CUSTOM | control::SEMANTIC_ZOOM
    );
    match children {
        0 => Keep::Drop,
        1 => Keep::Fold,
        _ if plain => Keep::Fold,
        _ => Keep::Line,
    }
}

/// Name, value and detail as the line shows them: nothing is said twice. A text area's
/// whole document is its value, so values may run longer than names before they are cut.
pub fn texts(facts: &Facts) -> (Option<String>, Option<String>, Option<String>) {
    let tidy = |text: &Option<String>, limit: usize| {
        text.as_deref().and_then(|t| super::error::clip(t, limit))
    };
    let mut name = tidy(&facts.name, 400);
    let mut value = if facts.password {
        None
    } else {
        tidy(&facts.value, 2000)
    };
    let mut detail = tidy(&facts.help, 400);
    if name.is_none() && facts.control_type == control::TEXT {
        name = value.take();
    }
    if name.is_none() && detail.is_some() && facts.control_type != control::EDIT {
        name = detail.take();
    }
    if value.is_some() && value == name {
        value = None;
    }
    if detail.is_some() && detail == name {
        detail = None;
    }
    (name, value, detail)
}

/// What an id stands for: the control's kind, the list row it sits in, and for controls that
/// act (buttons, items, check boxes) their name. Rows of virtualized lists are recycled for
/// other content, so a control whose row or name changed is another control: it gets a new id,
/// and acting on the old id is refused. Fields and text keep their id while their words change.
pub fn identity(facts: &Facts, row: Option<&str>) -> String {
    let named =
        is_actionable(facts) && !is_text_input(facts) && facts.control_type != control::WINDOW;
    format!(
        "{}|{}|{}",
        facts.control_type,
        row.unwrap_or(""),
        if named {
            facts.name.as_deref().unwrap_or("")
        } else {
            ""
        }
    )
}

/// List, tree and grid rows: their name identifies the content of everything inside them.
pub fn is_row(control_type: i32) -> bool {
    matches!(
        control_type,
        control::LIST_ITEM | control::DATA_ITEM | control::TREE_ITEM
    )
}

/// The actionable element under a window point: the innermost one whose frame holds it.
pub fn hit(nodes: &[Node], x: f64, y: f64) -> Option<&Node> {
    nodes
        .iter()
        .filter(|node| node.actionable && node.frame.is_some_and(|f| f.contains(x, y)))
        .min_by(|a, b| {
            let area = |n: &Node| n.frame.map_or(f64::MAX, |f| f.w * f.h);
            area(a)
                .partial_cmp(&area(b))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.depth.cmp(&a.depth))
        })
}

#[cfg(test)]
#[path = "outline_tests.rs"]
mod tests;
