// SPDX-License-Identifier: Apache-2.0
//! `android-ui.ts`: uiautomator's node-only XML as ADR 0011 nodes, the find over them, and the
//! input a semantic action becomes. A bounded parser: DTDs and entities are refused, nesting and
//! node counts are capped, and every malformed byte is `invalid_data` rather than a surprise.

use ace_json::{JsString, Value, json};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::platform::{Error, Refusal};

/// One accessibility node, in the schema's key order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub role: JsString,
    pub name: JsString,
    /// Today's `value`: Android always has one (the node's text, `""` when it has none) and a
    /// Simulator node has it only when serve-sim reported an `AXValue`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<JsString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<JsString>,
    pub bounds: Bounds,
    pub states: Vec<String>,
    pub actions: Vec<String>,
    pub children: Vec<Node>,
}

impl Node {
    fn without_children(&self) -> Self {
        let mut copy = self.clone();
        copy.children = Vec::new();
        copy
    }
}

/// A node's rectangle in framebuffer pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A parsed tree and whether a budget cut it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tree {
    pub nodes: Vec<Node>,
    pub truncated: bool,
}

/// `ScreenUITreeOptions`, as the caller's Zod schema already accepted it.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeOptions {
    #[serde(default = "default_depth")]
    pub max_depth: u32,
    #[serde(default = "default_nodes")]
    pub max_nodes: u32,
}

fn default_depth() -> u32 {
    8
}

fn default_nodes() -> u32 {
    128
}

impl Default for TreeOptions {
    fn default() -> Self {
        Self {
            max_depth: default_depth(),
            max_nodes: default_nodes(),
        }
    }
}

impl TreeOptions {
    /// The schema's bounds, for a caller that reached the addon without the TypeScript's Zod
    /// parse: `maxDepth` 0..=16 and `maxNodes` 1..=512.
    pub fn checked(self) -> Result<Self, Error> {
        if self.max_depth > 16 || self.max_nodes == 0 || self.max_nodes > 512 {
            return Err(Error::Invalid("tree options are out of range".into()));
        }
        Ok(self)
    }
}

/// A find over a tree, as `ScreenUIFindOptions` accepted it.
#[derive(Debug, Clone, Deserialize)]
pub struct FindOptions {
    pub query: Query,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    16
}

/// The three fields a find may ask for.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Query {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

/// A semantic action, as `ScreenUIActOptions` accepted it.
#[derive(Debug, Clone, Deserialize)]
pub struct ActOptions {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub action: String,
    #[serde(default)]
    pub value: Option<Value>,
}

/// An action's input, or why it needs none.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActInput {
    Tap {
        x: f64,
        y: f64,
    },
    Swipe {
        x: f64,
        y: f64,
        #[serde(rename = "toX")]
        to_x: f64,
        #[serde(rename = "toY")]
        to_y: f64,
        #[serde(rename = "durationMs")]
        duration_ms: f64,
    },
    None {
        method: &'static str,
    },
}

fn invalid(key: &str) -> Error {
    Refusal::word(key).into()
}

/// The first `units` UTF-16 code units, as JavaScript's `.slice(0, units)` takes them.
fn slice_units(text: &str, units: usize) -> String {
    let mut used = 0;
    let mut end = 0;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if used + width > units {
            break;
        }
        used += width;
        end = index + character.len_utf8();
    }
    text[..end].to_string()
}

fn sha_ref(prefix: &str, identity: &Value) -> String {
    let text = ace_json::ser::to_string(identity).unwrap_or_default();
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::with_capacity(40);
    for byte in digest.iter().take(20) {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("{prefix}_{hex}")
}

/// uiautomator escapes the five XML entities and numeric references; an unpaired surrogate or an
/// out-of-range code is invalid data, never a character.
fn decode(value: &str) -> Result<String, Error> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end) = after.find(';') else {
            out.push_str(after);
            return Ok(out);
        };
        let entity = &after[..=end];
        let decoded = match entity {
            "&quot;" => '"',
            "&apos;" => '\'',
            "&amp;" => '&',
            "&lt;" => '<',
            "&gt;" => '>',
            other => numeric(other)?,
        };
        out.push(decoded);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn numeric(entity: &str) -> Result<char, Error> {
    let raw = entity
        .strip_prefix("&#")
        .and_then(|rest| rest.strip_suffix(';'))
        .ok_or_else(|| invalid("androidEntityInvalid"))?;
    let code = match raw.strip_prefix('x').or_else(|| raw.strip_prefix('X')) {
        Some(hex) => u32::from_str_radix(hex, 16).map_err(|_| invalid("androidEntityInvalid"))?,
        None => raw
            .parse::<u32>()
            .map_err(|_| invalid("androidEntityInvalid"))?,
    };
    if (0xd800..=0xdfff).contains(&code) {
        return Err(invalid("androidEntityInvalid"));
    }
    char::from_u32(code).ok_or_else(|| invalid("androidEntityInvalid"))
}

fn is_word_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
}

/// The attributes of a `<node …>` tag, decoded; a duplicate or unterminated attribute is
/// malformed, as `android-ui.ts` refuses it.
fn attributes(tag: &str) -> Result<Vec<(String, String)>, Error> {
    let mut source = tag;
    if let Some(rest) = source.strip_prefix("<node") {
        source = rest;
    }
    let trimmed = source.trim_end();
    let trimmed = trimmed.strip_suffix('>').unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix('/').unwrap_or(trimmed);
    let bytes = trimmed.as_bytes();
    let mut values: Vec<(String, String)> = Vec::new();
    let mut cursor = 0;
    loop {
        if trimmed[cursor..].trim().is_empty() {
            break;
        }
        let start = &trimmed[cursor..];
        if !start.starts_with(char::is_whitespace) {
            return Err(invalid("androidAttributesMalformed"));
        }
        cursor += start.len() - start.trim_start().len();
        let name_start = cursor;
        if cursor >= bytes.len() || !is_word_start(bytes[cursor]) {
            return Err(invalid("androidAttributesMalformed"));
        }
        while cursor < bytes.len() && is_word_byte(bytes[cursor]) {
            cursor += 1;
        }
        let name = &trimmed[name_start..cursor];
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            return Err(invalid("androidAttributesMalformed"));
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'"' {
            return Err(invalid("androidAttributesMalformed"));
        }
        cursor += 1;
        let value_start = cursor;
        while cursor < bytes.len() && bytes[cursor] != b'"' {
            if bytes[cursor] == b'<' {
                return Err(invalid("androidAttributesMalformed"));
            }
            cursor += 1;
        }
        if cursor >= bytes.len() {
            return Err(invalid("androidAttributesMalformed"));
        }
        let value = &trimmed[value_start..cursor];
        cursor += 1;
        // `z.record(z.string().max(8192))` counts code points under ace's patched zod, so 8192
        // emoji fit and 8193 do not.
        if value.chars().count() > 8192 {
            return Err(invalid("androidAttributesMalformed"));
        }
        if values.iter().any(|(each, _)| each == name) {
            return Err(invalid("androidAttributesMalformed"));
        }
        values.push((name.to_string(), decode(value)?));
    }
    Ok(values)
}

fn attribute<'a>(values: &'a [(String, String)], key: &str) -> Option<&'a str> {
    values
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

fn bounds(values: &[(String, String)]) -> Result<Bounds, Error> {
    let raw = attribute(values, "bounds").ok_or_else(|| invalid("androidBoundsInvalid"))?;
    let numbers: Vec<f64> = raw
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<f64>().ok())
        .collect();
    let valid = raw.starts_with('[')
        && raw.contains("][")
        && raw.ends_with(']')
        && numbers.len() == 4
        && !raw
            .chars()
            .any(|character| !(character.is_ascii_digit() || matches!(character, '[' | ']' | ',')));
    if !valid {
        return Err(invalid("androidBoundsInvalid"));
    }
    let [x, y, right, bottom] = [numbers[0], numbers[1], numbers[2], numbers[3]];
    if right < x || bottom < y {
        return Err(invalid("androidBoundsInvalid"));
    }
    Ok(Bounds {
        x,
        y,
        w: right - x,
        h: bottom - y,
    })
}

fn mapped(values: &[(String, String)], path: &str) -> Result<Node, Error> {
    let bounds = bounds(values)?;
    let class = attribute(values, "class").unwrap_or("node");
    let role = slice_units(class, 128);
    let text = attribute(values, "text").unwrap_or("");
    let name = attribute(values, "content-desc")
        .filter(|value| !value.is_empty())
        .or((!text.is_empty()).then_some(text))
        .or(attribute(values, "resource-id"))
        .unwrap_or("");
    let mut states: Vec<String> = Vec::new();
    for key in ["focused", "selected", "checked"] {
        if attribute(values, key) == Some("true") {
            states.push(key.to_string());
        }
    }
    if attribute(values, "enabled") == Some("false") {
        states.push("disabled".to_string());
    }
    let mut actions: Vec<String> = Vec::new();
    if !states.iter().any(|state| state == "disabled") {
        if attribute(values, "clickable") == Some("true") {
            actions.push("press".to_string());
        }
        if attribute(values, "focusable") == Some("true") {
            actions.push("focus".to_string());
        }
        if attribute(values, "scrollable") == Some("true") {
            actions.push("scroll".to_string());
        }
        if attribute(values, "checkable") == Some("true") {
            actions.push("select".to_string());
        }
    }
    // Ref identifies the observed node and its position. Refreshes with changed resource, text,
    // package, or geometry invalidate an earlier action target.
    let identity = json!([
        path,
        attribute(values, "package"),
        attribute(values, "resource-id"),
        attribute(values, "class"),
        name,
        text,
        attribute(values, "bounds"),
        attribute(values, "enabled"),
    ]);
    Ok(Node {
        ref_: sha_ref("a", &identity),
        role: JsString::from(role),
        name: JsString::from(slice_units(name, 256)),
        value: Some(JsString::from(slice_units(text, 512))),
        description: None,
        bounds,
        states,
        actions,
        children: Vec::new(),
    })
}

/// One token of uiautomator's XML.
enum Tag<'a> {
    Declaration,
    HierarchyOpen,
    HierarchyClose,
    NodeOpen { tag: &'a str, closed: bool },
    NodeClose,
}

fn token_at(text: &str, at: usize) -> Option<(Tag<'_>, usize)> {
    let rest = &text[at..];
    if rest.starts_with("<?xml") {
        let end = rest.find("?>")?;
        return Some((Tag::Declaration, at + end + 2));
    }
    for (open, close, tag) in [
        ("<hierarchy", "</hierarchy", Tag::HierarchyOpen),
        (
            "<node",
            "</node",
            Tag::NodeOpen {
                tag: "",
                closed: false,
            },
        ),
    ] {
        if let Some(after) = rest.strip_prefix(close) {
            let trimmed = after.trim_start();
            if trimmed.starts_with('>') {
                let consumed = rest.len() - trimmed.len() + 1;
                let tag = if matches!(tag, Tag::HierarchyOpen) {
                    Tag::HierarchyClose
                } else {
                    Tag::NodeClose
                };
                return Some((tag, at + consumed));
            }
        }
        if rest.starts_with(open) {
            let end = rest.find('>')?;
            let tag_text = &rest[..=end];
            let body = tag_text.trim_end_matches('>');
            let closed = matches!(open, "<node") && body.trim_end().ends_with('/');
            let parsed = if matches!(open, "<hierarchy") {
                Tag::HierarchyOpen
            } else {
                Tag::NodeOpen {
                    tag: tag_text,
                    closed,
                }
            };
            return Some((parsed, at + end + 1));
        }
    }
    None
}

/// One open element while the parser walks the document.
struct Frame {
    id: Option<usize>,
    next: usize,
    path: String,
}

/// A bounded parser for uiautomator's node-only XML. DTDs/entities are rejected.
pub fn tree(xml: &str, options: TreeOptions) -> Result<Tree, Error> {
    let options = options.checked()?;
    if xml.len() > 1024 * 1024 || xml.contains("<!") {
        return Err(invalid("androidTreeBudget"));
    }
    let mut arena: Vec<Node> = Vec::new();
    let mut children: Vec<Vec<usize>> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut count: u32 = 0;
    let mut truncated = false;
    let mut opened = false;
    let mut closed = false;
    let mut cursor = 0;
    while let Some(at) = xml[cursor..].find('<').map(|offset| cursor + offset) {
        if !xml[cursor..at].trim().is_empty() {
            return Err(invalid("androidXmlMalformed"));
        }
        let Some((tag, next)) = token_at(xml, at) else {
            return Err(invalid("androidXmlMalformed"));
        };
        cursor = next;
        match tag {
            Tag::Declaration => {
                if opened {
                    return Err(invalid("androidXmlDeclaration"));
                }
            }
            Tag::HierarchyOpen => {
                if opened || closed {
                    return Err(invalid("androidHierarchyDuplicate"));
                }
                opened = true;
            }
            Tag::HierarchyClose => {
                if !opened || !stack.is_empty() {
                    return Err(invalid("androidNodeUnclosed"));
                }
                closed = true;
            }
            Tag::NodeClose => {
                if stack.pop().is_none() {
                    return Err(invalid("androidTreeUnbalanced"));
                }
            }
            Tag::NodeOpen { tag, closed: empty } => {
                if !opened || closed {
                    return Err(invalid("androidNodeOutsideHierarchy"));
                }
                if stack.len() > 128 {
                    return Err(invalid("androidNestingBudget"));
                }
                count += 1;
                if count > 32768 {
                    return Err(invalid("androidNestingBudget"));
                }
                let (path, parent) = match stack.last_mut() {
                    Some(frame) => {
                        let path = format!("{}_{}", frame.path, frame.next);
                        frame.next += 1;
                        (path, frame.id)
                    }
                    None => ((roots.len()).to_string(), None),
                };
                let retain = count <= options.max_nodes
                    && stack.len() <= options.max_depth as usize
                    && (parent.is_some() || stack.is_empty());
                let id = if retain {
                    let node = mapped(&attributes(tag)?, &path)?;
                    arena.push(node);
                    children.push(Vec::new());
                    let id = arena.len() - 1;
                    match parent {
                        Some(parent) => children[parent].push(id),
                        None => roots.push(id),
                    }
                    Some(id)
                } else {
                    truncated = true;
                    None
                };
                if !empty {
                    stack.push(Frame { id, next: 0, path });
                }
            }
        }
    }
    if !xml[cursor..].trim().is_empty() {
        return Err(invalid("androidXmlIncomplete"));
    }
    if !opened || !closed || !stack.is_empty() {
        return Err(invalid("androidXmlIncomplete"));
    }
    let nodes = roots
        .into_iter()
        .map(|id| build(&arena, &children, id))
        .collect();
    Ok(Tree { nodes, truncated })
}

fn build(arena: &[Node], children: &[Vec<usize>], id: usize) -> Node {
    let mut node = arena[id].clone();
    node.children = children[id]
        .iter()
        .map(|child| build(arena, children, *child))
        .collect();
    node
}

/// A node by its place in the tree, or the stale-ref refusal.
pub fn target(tree: &Tree, reference: &str) -> Result<Node, Error> {
    let mut pending: Vec<&Node> = tree.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        if node.ref_ == reference {
            return Ok(node.clone());
        }
        pending.extend(node.children.iter());
    }
    Err(invalid("androidTargetStale"))
}

/// The nodes a query names, newest-first depth walk as `android-ui.ts` runs it.
pub fn find(tree: &Tree, options: &FindOptions) -> Tree {
    let query = &options.query;
    let matches = |node: &Node| {
        let role = query
            .role
            .as_ref()
            .is_none_or(|role| node.role.to_lowercase().contains(&role.to_lowercase()));
        let name = query
            .name
            .as_ref()
            .is_none_or(|name| node.name.to_lowercase().contains(&name.to_lowercase()));
        // `value ?? name`: Android always has a value (`""` included), a Simulator node only
        // when serve-sim reported an `AXValue`.
        let text = query.text.as_ref().is_none_or(|text| {
            let haystack = node.value.as_ref().unwrap_or(&node.name);
            haystack.to_lowercase().contains(&text.to_lowercase())
        });
        role && name && text
    };
    let mut found = Vec::new();
    let mut truncated = tree.truncated;
    let mut pending: Vec<&Node> = tree.nodes.iter().rev().collect();
    while let Some(node) = pending.pop() {
        if matches(node) {
            if found.len() >= options.limit {
                truncated = true;
                break;
            }
            found.push(node.without_children());
        }
        pending.extend(node.children.iter().rev());
    }
    Tree {
        nodes: found,
        truncated,
    }
}

/// A scroll's `dx` and `dy`, as `ScreenUIActOptions` bounds them: whole numbers in ±1000.
pub fn scroll_amount(value: Option<&Value>) -> Result<(f64, f64), Error> {
    // `z.object(...).parse(action.value ?? {})`: anything but an object is refused, not read.
    let scroll = match value {
        None => None,
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| Error::Invalid("a scroll value is not an object".into()))?,
        ),
    };
    let amount = |key: &str| -> Result<f64, Error> {
        let Some(scroll) = scroll else {
            return Ok(0.0);
        };
        match scroll.get(key) {
            None => Ok(0.0),
            Some(value) => match value.as_f64() {
                Some(number) if number.fract() == 0.0 && (-1000.0..=1000.0).contains(&number) => {
                    Ok(number)
                }
                _ => Err(Error::Invalid("a scroll amount is out of range".into())),
            },
        }
    };
    Ok((amount("dx")?, amount("dy")?))
}

/// The device input that performs a semantic action on a node, or why it can't be done.
pub fn act(node: &Node, options: &ActOptions) -> Result<ActInput, Error> {
    if !node.actions.iter().any(|action| action == &options.action)
        || node.states.iter().any(|state| state == "disabled")
    {
        return Err(invalid("androidActionUnsupported"));
    }
    if node.bounds.w == 0.0 || node.bounds.h == 0.0 {
        return Err(invalid("androidActionUnsupported"));
    }
    if options.action == "select"
        && let Some(Value::Bool(wanted)) = options.value
        && (node.states.iter().any(|state| state == "checked")
            || node.states.iter().any(|state| state == "selected"))
            == wanted
    {
        return Ok(ActInput::None {
            method: "already_selected",
        });
    }
    let centre = (
        (node.bounds.x + node.bounds.w / 2.0).floor(),
        (node.bounds.y + node.bounds.h / 2.0).floor(),
    );
    if options.action != "scroll" {
        return Ok(ActInput::Tap {
            x: centre.0,
            y: centre.1,
        });
    }
    let (dx, dy) = scroll_amount(options.value.as_ref())?;
    if dx == 0.0 && dy == 0.0 {
        return Ok(ActInput::None {
            method: "no_scroll",
        });
    }
    Ok(ActInput::Swipe {
        x: centre.0,
        y: centre.1,
        to_x: (centre.0 - dx)
            .max(node.bounds.x)
            .min(node.bounds.x + node.bounds.w - 1.0),
        to_y: (centre.1 - dy)
            .max(node.bounds.y)
            .min(node.bounds.y + node.bounds.h - 1.0),
        duration_ms: 300.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump(label: &str) -> String {
        format!(
            "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">\
             <node index=\"0\" text=\"{label}\" class=\"android.widget.Button\" clickable=\"true\" \
             enabled=\"true\" bounds=\"[0,0][10,10]\" /></hierarchy>"
        )
    }

    #[test]
    fn tree_options_keep_the_schemas_bounds() {
        assert!(TreeOptions::default().checked().is_ok());
        assert!(
            TreeOptions {
                max_depth: 17,
                max_nodes: 128
            }
            .checked()
            .is_err()
        );
        assert!(
            TreeOptions {
                max_depth: 0,
                max_nodes: 0
            }
            .checked()
            .is_err()
        );
        assert!(
            TreeOptions {
                max_depth: 16,
                max_nodes: 513
            }
            .checked()
            .is_err()
        );
    }

    #[test]
    fn a_ui_dump_becomes_nodes_with_bounds_actions_and_a_stable_ref() {
        let parsed = tree(&dump("Helper"), TreeOptions::default()).expect("parses");
        let [node] = &parsed.nodes[..] else {
            panic!("one node")
        };
        assert_eq!(node.role, "android.widget.Button");
        assert_eq!(node.name, "Helper");
        assert_eq!(node.value.as_deref(), Some("Helper"));
        assert_eq!(
            node.bounds,
            Bounds {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0
            }
        );
        assert_eq!(node.actions, vec!["press"]);
        let again = tree(&dump("Helper"), TreeOptions::default()).expect("parses");
        assert_eq!(again.nodes[0].ref_, node.ref_);
        let moved = dump("Moved");
        assert_ne!(
            tree(&moved, TreeOptions::default()).expect("parses").nodes[0].ref_,
            node.ref_
        );
    }

    #[test]
    fn a_nested_tree_keeps_its_children_and_depth_budget() {
        let xml = "<hierarchy rotation=\"0\">\
            <node class=\"Root\" bounds=\"[0,0][100,100]\">\
            <node class=\"Child\" bounds=\"[0,0][50,50]\" /></node></hierarchy>";
        let full = tree(xml, TreeOptions::default()).expect("parses");
        assert_eq!(full.nodes.len(), 1);
        assert_eq!(full.nodes[0].children.len(), 1);
        let shallow = tree(
            xml,
            TreeOptions {
                max_depth: 0,
                max_nodes: 128,
            },
        )
        .expect("parses");
        assert!(shallow.nodes[0].children.is_empty());
        assert!(shallow.truncated);
    }

    #[test]
    fn entities_are_decoded_and_a_dtd_or_a_surrogate_reference_is_refused() {
        let xml =
            "<hierarchy><node text=\"a &amp; b &lt;c&gt;\" bounds=\"[0,0][10,10]\" /></hierarchy>";
        let parsed = tree(xml, TreeOptions::default()).expect("parses");
        assert_eq!(parsed.nodes[0].value.as_deref(), Some("a & b <c>"));
        let bad = "<hierarchy><node text=\"&#xD800;\" bounds=\"[0,0][10,10]\" /></hierarchy>";
        assert!(tree(bad, TreeOptions::default()).is_err());
        assert!(
            tree(
                "<!DOCTYPE x><hierarchy></hierarchy>",
                TreeOptions::default()
            )
            .is_err()
        );
    }

    #[test]
    fn node_field_caps_are_utf16_units_as_the_slices_are_not_code_points() {
        let emoji = "\u{1f44b}";
        let label = emoji.repeat(300);
        let xml = format!(
            "<hierarchy><node class=\"Button\" content-desc=\"{label}\" text=\"{label}\" \
             bounds=\"[0,0][10,10]\" /></hierarchy>"
        );
        let tree = tree(&xml, TreeOptions::default()).expect("parses");
        let node = &tree.nodes[0];
        // `.slice(0, 256)` keeps 256 UTF-16 units, so 128 of the 300 emoji.
        assert_eq!(node.name.chars().count(), 128);
        assert_eq!(node.name.len_utf16(), 256);
        // `.slice(0, 512)` keeps 256 emoji.
        let value = node.value.as_ref().expect("a value");
        assert_eq!(value.chars().count(), 256);
        assert_eq!(value.len_utf16(), 512);
    }

    #[test]
    fn an_attribute_value_is_capped_at_8192_code_points_as_the_schema_counts_them() {
        let emoji = "\u{1f44b}";
        let fits = format!(
            "<hierarchy><node class=\"Button\" text=\"{}\" bounds=\"[0,0][10,10]\" /></hierarchy>",
            emoji.repeat(8192)
        );
        assert!(tree(&fits, TreeOptions::default()).is_ok());
        let too_long = format!(
            "<hierarchy><node class=\"Button\" text=\"{}\" bounds=\"[0,0][10,10]\" /></hierarchy>",
            emoji.repeat(8193)
        );
        assert!(tree(&too_long, TreeOptions::default()).is_err());
    }

    #[test]
    fn an_android_node_always_has_a_value_so_a_text_find_never_falls_back_to_its_name() {
        let xml = "<hierarchy><node class=\"Button\" content-desc=\"Settings\" text=\"\" \
            bounds=\"[0,0][10,10]\" /></hierarchy>";
        let tree = tree(xml, TreeOptions::default()).expect("parses");
        assert_eq!(tree.nodes[0].value.as_deref(), Some(""));
        let text = find(
            &tree,
            &FindOptions {
                query: Query {
                    text: Some("settings".into()),
                    ..Query::default()
                },
                limit: 16,
            },
        );
        assert!(
            text.nodes.is_empty(),
            "value ?? name, and the value is empty"
        );
        let name = find(
            &tree,
            &FindOptions {
                query: Query {
                    name: Some("settings".into()),
                    ..Query::default()
                },
                limit: 16,
            },
        );
        assert_eq!(name.nodes.len(), 1);
    }

    #[test]
    fn a_scroll_value_that_is_not_an_object_is_refused_like_the_schema() {
        let xml = "<hierarchy><node class=\"List\" scrollable=\"true\" \
            bounds=\"[0,0][100,200]\" /></hierarchy>";
        let tree = tree(xml, TreeOptions::default()).expect("parses");
        let node = tree.nodes[0].clone();
        assert!(
            act(
                &node,
                &ActOptions {
                    ref_: node.ref_.clone(),
                    action: "scroll".into(),
                    value: Some(json!("down")),
                }
            )
            .is_err()
        );
    }

    #[test]
    fn a_find_matches_on_role_name_or_text_and_a_target_goes_stale_when_it_vanishes() {
        let xml = "<hierarchy><node class=\"Button\" text=\"Save\" clickable=\"true\" bounds=\"[0,0][20,20]\" />\
            <node class=\"Text\" text=\"Saved\" bounds=\"[0,20][20,40]\" /></hierarchy>";
        let parsed = tree(xml, TreeOptions::default()).expect("parses");
        let found = find(
            &parsed,
            &FindOptions {
                query: Query {
                    text: Some("sav".into()),
                    ..Query::default()
                },
                limit: 16,
            },
        );
        assert_eq!(found.nodes.len(), 2);
        let node = target(&parsed, &parsed.nodes[0].ref_).expect("found");
        assert_eq!(
            act(
                &node,
                &ActOptions {
                    ref_: node.ref_.clone(),
                    action: "press".into(),
                    value: None,
                }
            )
            .expect("acts"),
            ActInput::Tap { x: 10.0, y: 10.0 }
        );
        assert!(target(&parsed, "a_missing").is_err());
    }

    #[test]
    fn a_scroll_is_bounded_to_the_nodes_box_and_a_select_already_on_says_so() {
        let xml = "<hierarchy><node class=\"List\" scrollable=\"true\" checkable=\"true\" \
            checked=\"true\" bounds=\"[0,0][100,200]\" /></hierarchy>";
        let parsed = tree(xml, TreeOptions::default()).expect("parses");
        let node = parsed.nodes[0].clone();
        assert_eq!(
            act(
                &node,
                &ActOptions {
                    ref_: node.ref_.clone(),
                    action: "select".into(),
                    value: Some(Value::Bool(true)),
                }
            )
            .expect("acts"),
            ActInput::None {
                method: "already_selected"
            }
        );
        // A scroll amount outside ±1000 is what the schema refuses, so it never reaches input.
        assert!(
            act(
                &node,
                &ActOptions {
                    ref_: node.ref_.clone(),
                    action: "scroll".into(),
                    value: Some(json!({"dx": 0, "dy": 5000})),
                }
            )
            .is_err()
        );
        assert_eq!(
            act(
                &node,
                &ActOptions {
                    ref_: node.ref_.clone(),
                    action: "scroll".into(),
                    value: Some(json!({"dx": 0, "dy": 400})),
                }
            )
            .expect("acts"),
            ActInput::Swipe {
                x: 50.0,
                y: 100.0,
                to_x: 50.0,
                to_y: 0.0,
                duration_ms: 300.0,
            }
        );
    }
}
