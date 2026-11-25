// SPDX-License-Identifier: Apache-2.0
//! `simulator-ax.ts`: serve-sim's `/ax` tree as ADR 0011 nodes. Frames are iOS points in the
//! app's own layout, which is not always the device's, so the layout is worked out first and each
//! rectangle is turned back onto the portrait framebuffer the picture and the input use.

use ace_json::{JsString, Value};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::platform::android_ui::{ActInput, Bounds, Node, Tree, TreeOptions};
use crate::platform::{Error, Refusal};

/// Degrees clockwise a viewer turns a picture to show it upright.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Turn {
    #[serde(rename = "0")]
    None,
    #[serde(rename = "90")]
    Quarter,
    #[serde(rename = "180")]
    Half,
    #[serde(rename = "270")]
    ThreeQuarters,
}

/// serve-sim's announced orientation as the turn a viewer needs; unknown names keep the picture.
pub fn rotation(orientation: &str) -> Turn {
    match orientation {
        "landscape_left" => Turn::Quarter,
        "portrait_upside_down" => Turn::Half,
        "landscape_right" => Turn::ThreeQuarters,
        _ => Turn::None,
    }
}

/// The screen a tree is read against.
#[derive(Debug, Clone, Deserialize)]
pub struct Screen {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub orientation: Option<String>,
}

impl Screen {
    fn orientation(&self) -> &str {
        self.orientation.as_deref().unwrap_or("portrait")
    }
}

/// How a tree's points sit on the framebuffer: the layout's size in points and its turn.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub turn: Turn,
}

/// One element of serve-sim's answer; fields are read leniently and missing ones default.
#[derive(Debug, Clone)]
struct Element {
    label: JsString,
    value: JsString,
    unique_id: JsString,
    kind: JsString,
    role_description: JsString,
    enabled: bool,
    frame: Rect,
    children: Vec<Value>,
}

#[derive(Debug, Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn text(value: &Value) -> JsString {
    value.as_js_str().cloned().unwrap_or_default()
}

fn element(raw: &Value) -> Option<Element> {
    let object = raw.as_object()?;
    let frame = object.get("frame")?.as_object()?;
    let finite = |key: &str, allow_zero: bool| {
        frame
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && (allow_zero || *value >= 0.0))
    };
    let frame = Rect {
        x: finite("x", true)?,
        y: finite("y", true)?,
        width: finite("width", false)?,
        height: finite("height", false)?,
    };
    // `z.array(z.unknown()).max(4096).catch([])`: children that are missing, not an array, or
    // past the cap leave the element with none rather than dropping it.
    let children = match object.get("children") {
        Some(Value::Array(children)) if children.len() <= 4096 => children.to_vec(),
        _ => Vec::new(),
    };
    Some(Element {
        label: text(object.get("AXLabel").unwrap_or(&Value::Null)),
        value: text(object.get("AXValue").unwrap_or(&Value::Null)),
        unique_id: text(object.get("AXUniqueId").unwrap_or(&Value::Null)),
        kind: text(object.get("type").unwrap_or(&Value::Null)),
        role_description: text(object.get("role_description").unwrap_or(&Value::Null)),
        enabled: object
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        frame,
        children,
    })
}

fn roots(raw: &Value) -> Option<Vec<Value>> {
    let roots = raw.as_array()?;
    (roots.len() <= 64).then(|| roots.to_vec())
}

/// The app's layout under serve-sim's tree: the root reports the window's portrait frame either
/// way, so on a device turned a quarter the elements' reach decides; past the portrait width, the
/// layout is turned with it. A device held upright is taken at its word.
pub fn layout(raw: &Value, screen: &Screen) -> Layout {
    let Some(roots) = roots(raw) else {
        return Layout {
            width: screen.width,
            height: screen.height,
            turn: Turn::None,
        };
    };
    let Some(root) = roots.first().and_then(element).map(|element| element.frame) else {
        return Layout {
            width: screen.width,
            height: screen.height,
            turn: Turn::None,
        };
    };
    if root.width == 0.0 || root.height == 0.0 {
        return Layout {
            width: screen.width,
            height: screen.height,
            turn: Turn::None,
        };
    }
    let short = root.width.min(root.height);
    let long = root.width.max(root.height);
    let portrait = screen.width <= screen.height;
    // The furthest any element reaches across the framebuffer's short side, from a bounded walk.
    let mut reach: f64 = 0.0;
    let mut pending = roots.clone();
    let mut seen = 0;
    while let Some(raw) = pending.pop() {
        if seen >= 512 {
            break;
        }
        seen += 1;
        let Some(element) = element(&raw) else {
            continue;
        };
        let frame = element.frame;
        reach = reach.max(if portrait {
            frame.x + frame.width
        } else {
            frame.y + frame.height
        });
        pending.extend(element.children.iter().cloned());
    }
    let device = rotation(screen.orientation());
    let turned = !matches!(device, Turn::None | Turn::Half) && reach > short * 1.05;
    let turn = if turned { device } else { Turn::None };
    if turned == portrait {
        Layout {
            width: long,
            height: short,
            turn,
        }
    } else {
        Layout {
            width: short,
            height: long,
            turn,
        }
    }
}

fn unturn(rect: Rect, turn: Turn) -> Rect {
    let point = |u: f64, v: f64| -> (f64, f64) {
        match turn {
            Turn::Quarter => (v, 1.0 - u),
            Turn::Half => (1.0 - u, 1.0 - v),
            Turn::ThreeQuarters => (1.0 - v, u),
            Turn::None => (u, v),
        }
    };
    let (ax, ay) = point(rect.x, rect.y);
    let (bx, by) = point(rect.x + rect.width, rect.y + rect.height);
    Rect {
        x: ax.min(bx),
        y: ay.min(by),
        width: (bx - ax).abs(),
        height: (by - ay).abs(),
    }
}

fn pressable(kind: &str) -> bool {
    matches!(
        kind,
        "Button"
            | "Cell"
            | "Link"
            | "Image"
            | "Icon"
            | "Key"
            | "MenuItem"
            | "Tab"
            | "TabBarButton"
            | "SegmentedControl"
            | "StaticText"
            | "Switch"
            | "Toggle"
            | "CheckBox"
            | "RadioButton"
            | "PopUpButton"
            | "DisclosureTriangle"
    )
}

fn editable(kind: &str) -> bool {
    matches!(
        kind,
        "TextField" | "SecureTextField" | "SearchField" | "TextView" | "TextArea"
    )
}

fn scrollable(kind: &str) -> bool {
    matches!(
        kind,
        "ScrollView" | "Table" | "CollectionView" | "List" | "WebView"
    )
}

fn toggles(kind: &str) -> bool {
    matches!(kind, "Switch" | "Toggle" | "CheckBox")
}

fn sha_ref(identity: &Value) -> String {
    let text = ace_json::ser::to_string(identity).unwrap_or_default();
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::with_capacity(40);
    for byte in digest.iter().take(20) {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("i_{hex}")
}

fn mapped(element: &Element, path: &str, layout: Layout, screen: &Screen) -> Node {
    let kind = if element.kind.is_empty() {
        if element.role_description.is_empty() {
            JsString::from("element")
        } else {
            element.role_description.clone()
        }
    } else {
        element.kind.clone()
    };
    let name = if element.label.is_empty() {
        element.unique_id.clone()
    } else {
        element.label.clone()
    };
    let shown = unturn(
        Rect {
            x: element.frame.x / layout.width,
            y: element.frame.y / layout.height,
            width: element.frame.width / layout.width,
            height: element.frame.height / layout.height,
        },
        layout.turn,
    );
    let bounds = Bounds {
        x: crate::platform::scrcpy::protocol::js_round(shown.x * screen.width),
        y: crate::platform::scrcpy::protocol::js_round(shown.y * screen.height),
        w: crate::platform::scrcpy::protocol::js_round(shown.width * screen.width),
        h: crate::platform::scrcpy::protocol::js_round(shown.height * screen.height),
    };
    let mut states: Vec<String> = Vec::new();
    if toggles(&kind) && element.value == "1" {
        states.push("checked".to_string());
    }
    if !element.enabled {
        states.push("disabled".to_string());
    }
    if bounds.x + bounds.w <= 0.0
        || bounds.y + bounds.h <= 0.0
        || (screen.width > 0.0 && bounds.x >= screen.width)
        || (screen.height > 0.0 && bounds.y >= screen.height)
    {
        states.push("offscreen".to_string());
    }
    let mut actions: Vec<String> = Vec::new();
    if element.enabled
        && bounds.w > 0.0
        && bounds.h > 0.0
        && !states.iter().any(|state| state == "offscreen")
    {
        if pressable(&kind) {
            actions.push("press".to_string());
        }
        if editable(&kind) {
            actions.push("press".to_string());
            actions.push("focus".to_string());
        }
        if scrollable(&kind) {
            actions.push("scroll".to_string());
        }
        if toggles(&kind) {
            actions.push("select".to_string());
        }
    }
    // The ref names this element at this place in this tree. A later read where it moved,
    // changed label or changed identity yields a different ref, so an old ref goes stale.
    let identity = ace_json::json!([
        path,
        kind,
        element.unique_id,
        element.label,
        {"x": bounds.x, "y": bounds.y, "w": bounds.w, "h": bounds.h},
    ]);
    Node {
        ref_: sha_ref(&identity),
        role: kind.slice_units(0, 128),
        name: name.slice_units(0, 256),
        value: (!element.value.is_empty()).then(|| element.value.slice_units(0, 512)),
        description: (!element.unique_id.is_empty() && element.unique_id != name)
            .then(|| element.unique_id.slice_units(0, 256)),
        bounds,
        states,
        actions,
        children: Vec::new(),
    }
}

/// Map serve-sim's accessibility tree to ADR 0011 nodes, turned back onto the framebuffer.
pub fn tree(raw: &Value, screen: &Screen, options: TreeOptions) -> Result<Tree, Error> {
    let Some(roots) = roots(raw) else {
        return Err(Refusal::word("simulatorTreeMalformed").into());
    };
    let layout = layout(raw, screen);
    struct Pending {
        raw: Value,
        depth: u32,
        path: String,
        parent: Option<usize>,
    }
    let mut arena: Vec<Node> = Vec::new();
    let mut children: Vec<Vec<usize>> = Vec::new();
    let mut kept: Vec<usize> = Vec::new();
    let mut count: u32 = 0;
    let mut truncated = false;
    // Last root first, so the walk pops the answer's first root and each node's first child.
    let mut pending: Vec<Pending> = (0..roots.len())
        .rev()
        .map(|index| Pending {
            raw: roots[index].clone(),
            depth: 0,
            path: index.to_string(),
            parent: None,
        })
        .collect();
    while let Some(item) = pending.pop() {
        let Some(element) = element(&item.raw) else {
            // An element without a usable frame is skipped with its subtree, never fatal.
            continue;
        };
        count += 1;
        if count > options.max_nodes || item.depth > options.max_depth {
            truncated = true;
            continue;
        }
        let node = mapped(&element, &item.path, layout, screen);
        arena.push(node);
        children.push(Vec::new());
        let id = arena.len() - 1;
        match item.parent {
            Some(parent) => children[parent].push(id),
            None => kept.push(id),
        }
        for (index, child) in element.children.iter().enumerate().rev() {
            pending.push(Pending {
                raw: child.clone(),
                depth: item.depth + 1,
                path: format!("{}_{index}", item.path),
                parent: Some(id),
            });
        }
    }
    let nodes = kept
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

/// Find the node a ref names in a fresh tree; a ref absent from it is stale.
pub fn target(tree: &Tree, reference: &str) -> Result<Node, Error> {
    let mut pending: Vec<&Node> = tree.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        if node.ref_ == reference {
            return Ok(node.clone());
        }
        pending.extend(node.children.iter());
    }
    Err(Refusal::word("simulatorTargetStale").into())
}

/// The device input that performs a semantic action on a node, or why it can't be done. A scroll
/// is asked for in the upright layout; on a turned device it runs across the framebuffer.
pub fn action_input(
    node: &Node,
    action: &str,
    value: Option<&Value>,
    turn: Turn,
) -> Result<ActInput, Error> {
    if !node.actions.iter().any(|each| each == action)
        || node.states.iter().any(|state| state == "disabled")
    {
        return Err(Refusal::word("simulatorActionUnsupported").into());
    }
    let centre = (
        (node.bounds.x + node.bounds.w / 2.0).floor(),
        (node.bounds.y + node.bounds.h / 2.0).floor(),
    );
    if action == "select"
        && let Some(Value::Bool(wanted)) = value
        && node.states.iter().any(|state| state == "checked") == *wanted
    {
        return Ok(ActInput::None {
            method: "already_selected",
        });
    }
    if action != "scroll" {
        return Ok(ActInput::Tap {
            x: centre.0,
            y: centre.1,
        });
    }
    let (dx, dy) = crate::platform::android_ui::scroll_amount(value)?;
    if dx == 0.0 && dy == 0.0 {
        return Ok(ActInput::None {
            method: "no_scroll",
        });
    }
    let (dx, dy) = match turn {
        Turn::Quarter => (dy, -dx),
        Turn::Half => (-dx, -dy),
        Turn::ThreeQuarters => (-dy, dx),
        Turn::None => (dx, dy),
    };
    let clamp = |value: f64, start: f64, size: f64| value.max(start).min(start + size - 1.0);
    Ok(ActInput::Swipe {
        x: centre.0,
        y: centre.1,
        to_x: clamp(centre.0 - dx, node.bounds.x, node.bounds.w),
        to_y: clamp(centre.1 - dy, node.bounds.y, node.bounds.h),
        duration_ms: 300.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> Screen {
        Screen {
            width: 1206.0,
            height: 2622.0,
            orientation: None,
        }
    }

    fn element(fields: Value, children: Vec<Value>) -> Value {
        let mut object = ace_json::json!({
            "AXLabel": null,
            "AXValue": null,
            "AXUniqueId": null,
            "enabled": true,
            "role_description": "button",
            "type": "Button",
        });
        let map = object.as_object_mut().expect("an object");
        if let Value::Object(fields) = fields {
            for (key, value) in fields {
                map.insert(key, value);
            }
        }
        map.insert(
            "children".to_string(),
            ace_json::Value::Array(ace_json::Array::from(children)),
        );
        object
    }

    fn settings() -> Value {
        ace_json::json!([element(
            ace_json::json!({"type": "Application", "AXLabel": "Settings", "frame": {"x": 0, "y": 0, "width": 402, "height": 874}}),
            vec![
                element(
                    ace_json::json!({"AXLabel": "General", "frame": {"x": 16, "y": 300, "width": 370, "height": 52}}),
                    vec![]
                ),
                element(
                    ace_json::json!({"type": "Switch", "AXLabel": "Airplane Mode", "AXValue": "1", "AXUniqueId": "airplane", "frame": {"x": 16, "y": 200, "width": 370, "height": 52}}),
                    vec![]
                ),
                element(
                    ace_json::json!({"AXLabel": "Disabled", "enabled": false, "frame": {"x": 16, "y": 400, "width": 370, "height": 52}}),
                    vec![]
                ),
                element(
                    ace_json::json!({"type": "ScrollView", "frame": {"x": 0, "y": 100, "width": 402, "height": 700}}),
                    vec![]
                ),
                ace_json::json!({"frame": "not a frame", "AXLabel": "broken"}),
                element(
                    ace_json::json!({"AXLabel": "Offscreen", "frame": {"x": 0, "y": 2000, "width": 100, "height": 40}}),
                    vec![]
                ),
                element(
                    ace_json::json!({"AXLabel": "Future", "frame": {"x": 1, "y": 1, "width": 2, "height": 2}, "newField": [1, 2]}),
                    vec![]
                ),
            ],
        )])
    }

    #[test]
    fn maps_the_accessibility_tree_to_framebuffer_pixels_with_actions_states_and_refs() {
        let tree = tree(
            &settings(),
            &screen(),
            TreeOptions {
                max_nodes: 64,
                max_depth: 4,
            },
        )
        .expect("parses");
        let app = &tree.nodes[0];
        assert_eq!(app.role, "Application");
        assert_eq!(app.name, "Settings");
        assert_eq!(
            app.bounds,
            Bounds {
                x: 0.0,
                y: 0.0,
                w: 1206.0,
                h: 2622.0
            }
        );
        let by_name = |name: &str| app.children.iter().find(|node| node.name == name);
        assert_eq!(
            by_name("General").expect("found").bounds,
            Bounds {
                x: 48.0,
                y: 900.0,
                w: 1110.0,
                h: 156.0
            }
        );
        assert_eq!(by_name("General").expect("found").actions, vec!["press"]);
        let airplane = by_name("Airplane Mode").expect("found");
        assert_eq!(airplane.value.as_deref(), Some("1"));
        assert_eq!(airplane.description.as_deref(), Some("airplane"));
        assert_eq!(airplane.states, vec!["checked"]);
        assert_eq!(airplane.actions, vec!["press", "select"]);
        assert_eq!(by_name("Disabled").expect("found").states, vec!["disabled"]);
        assert!(by_name("Disabled").expect("found").actions.is_empty());
        assert_eq!(
            by_name("Offscreen").expect("found").states,
            vec!["offscreen"]
        );
        let scroll = app
            .children
            .iter()
            .find(|node| node.role == "ScrollView")
            .expect("found");
        assert_eq!(scroll.actions, vec!["scroll"]);
        assert!(by_name("broken").is_none());
        assert!(by_name("Future").is_some());
        assert!(!tree.truncated);
    }

    #[test]
    fn a_node_without_a_value_omits_it_and_a_text_find_then_falls_back_to_its_name() {
        let raw = ace_json::json!([element(
            ace_json::json!({"type": "Button", "AXLabel": "Settings", "frame": {"x": 0, "y": 0, "width": 402, "height": 874}}),
            vec![],
        )]);
        let tree = tree(&raw, &screen(), TreeOptions::default()).expect("parses");
        let node = &tree.nodes[0];
        assert_eq!(node.value, None);
        let text = ace_json::ser::to_string(node).expect("serializes");
        assert!(!text.contains("\"value\""), "{text}");
        // `value ?? name`: with no value, a text find reads the name.
        let found = crate::platform::android_ui::find(
            &tree,
            &crate::platform::android_ui::FindOptions {
                query: crate::platform::android_ui::Query {
                    text: Some("sett".into()),
                    ..crate::platform::android_ui::Query::default()
                },
                limit: 16,
            },
        );
        assert_eq!(found.nodes.len(), 1);
    }

    #[test]
    fn children_that_are_null_or_past_the_cap_keep_the_element_without_them() {
        let too_many =
            ace_json::Value::Array(ace_json::Array::from(vec![ace_json::json!(0); 4097]));
        for children in [ace_json::json!(null), ace_json::json!("text"), too_many] {
            let mut root = element(
                ace_json::json!({"type": "Application", "AXLabel": "Root", "frame": {"x": 0, "y": 0, "width": 402, "height": 874}}),
                vec![],
            );
            root.as_object_mut()
                .expect("an object")
                .insert("children".to_string(), children);
            let raw = ace_json::json!([root]);
            let tree = tree(&raw, &screen(), TreeOptions::default()).expect("parses");
            assert_eq!(tree.nodes.len(), 1, "the root stays");
            assert!(tree.nodes[0].children.is_empty());
        }
    }

    #[test]
    fn a_label_with_a_lone_surrogate_keeps_its_code_units() {
        let label = ace_json::to_value(&ace_json::JsString::from_units(&[0x41, 0xd800, 0x42]));
        let raw = ace_json::json!([element(
            ace_json::json!({"type": "Button", "AXLabel": label, "frame": {"x": 0, "y": 0, "width": 402, "height": 874}}),
            vec![],
        )]);
        let tree = tree(&raw, &screen(), TreeOptions::default()).expect("parses");
        let name = &tree.nodes[0].name;
        assert_eq!(name.len_utf16(), 3);
        let units: Vec<u16> = name.units().collect();
        assert_eq!(units, vec![0x41, 0xd800, 0x42]);
    }

    #[test]
    fn a_malformed_answer_is_invalid_data() {
        let error = tree(
            &ace_json::json!({"not": "an array"}),
            &screen(),
            TreeOptions::default(),
        )
        .expect_err("refused");
        assert_eq!(
            error.to_string(),
            "invalid_data: Simulator accessibility tree is malformed"
        );
    }

    #[test]
    fn node_and_depth_budgets_truncate_the_tree_and_say_so() {
        let shallow = tree(
            &settings(),
            &screen(),
            TreeOptions {
                max_nodes: 128,
                max_depth: 0,
            },
        )
        .expect("parses");
        assert!(shallow.nodes[0].children.is_empty());
        assert!(shallow.truncated);
    }

    #[test]
    fn refs_survive_an_identical_reread_and_go_stale_when_the_element_moves() {
        let first = tree(&settings(), &screen(), TreeOptions::default()).expect("parses");
        let general = first.nodes[0].children[0].ref_.clone();
        let again = tree(&settings(), &screen(), TreeOptions::default()).expect("parses");
        assert_eq!(target(&again, &general).expect("found").name, "General");
        let mut moved = settings();
        let replacement = element(
            ace_json::json!({"AXLabel": "General", "frame": {"x": 16, "y": 360, "width": 370, "height": 52}}),
            vec![],
        );
        if let Some(root) = moved.get_mut(&0)
            && let Some(children) = root
                .as_object_mut()
                .and_then(|root| root.get_mut("children"))
                .and_then(|children| children.as_array_mut())
        {
            children[0] = replacement;
        }
        let moved = tree(&moved, &screen(), TreeOptions::default()).expect("parses");
        assert!(target(&moved, &general).is_err());
    }

    #[test]
    fn actions_become_a_tap_at_the_centre_a_bounded_swipe_or_nothing_to_do() {
        let tree = tree(&settings(), &screen(), TreeOptions::default()).expect("parses");
        let node = |name: &str| {
            tree.nodes[0]
                .children
                .iter()
                .find(|node| node.name == name || node.role == name)
                .cloned()
                .expect(name)
        };
        assert_eq!(
            action_input(&node("General"), "press", None, Turn::None).expect("acts"),
            ActInput::Tap { x: 603.0, y: 978.0 }
        );
        assert_eq!(
            action_input(
                &node("Airplane Mode"),
                "select",
                Some(&Value::Bool(true)),
                Turn::None
            )
            .expect("acts"),
            ActInput::None {
                method: "already_selected"
            }
        );
        assert_eq!(
            action_input(
                &node("ScrollView"),
                "scroll",
                Some(&ace_json::json!({"dx": 0, "dy": 400})),
                Turn::None
            )
            .expect("acts"),
            ActInput::Swipe {
                x: 603.0,
                y: 1350.0,
                to_x: 603.0,
                to_y: 950.0,
                duration_ms: 300.0
            }
        );
        assert!(action_input(&node("Disabled"), "press", None, Turn::None).is_err());
    }

    /// An iPhone Duo's inner screen: the root keeps the window's portrait frame while the app is
    /// laid out landscape. Its framebuffer stays portrait.
    fn landscape() -> Value {
        ace_json::json!([element(
            ace_json::json!({"type": "Application", "AXLabel": "Settings", "frame": {"x": 0, "y": 0, "width": 669, "height": 951}}),
            vec![
                element(
                    ace_json::json!({"type": "Group", "frame": {"x": 0, "y": 0, "width": 951, "height": 669}}),
                    vec![]
                ),
                element(
                    ace_json::json!({"AXLabel": "About", "frame": {"x": 340, "y": 303.67, "width": 527, "height": 52}}),
                    vec![]
                ),
                element(
                    ace_json::json!({"type": "ScrollView", "AXLabel": "List", "frame": {"x": 340, "y": 100, "width": 527, "height": 500}}),
                    vec![]
                ),
            ],
        )])
    }

    fn inner_screen() -> Screen {
        Screen {
            width: 2007.0,
            height: 2853.0,
            orientation: Some("landscape_left".to_string()),
        }
    }

    #[test]
    fn on_a_turned_screen_elements_land_where_the_portrait_framebuffer_shows_them() {
        let tree = tree(
            &landscape(),
            &inner_screen(),
            TreeOptions {
                max_nodes: 64,
                max_depth: 4,
            },
        )
        .expect("parses");
        let about = tree.nodes[0]
            .children
            .iter()
            .find(|node| node.name == "About")
            .expect("found");
        assert_eq!(
            about.bounds,
            Bounds {
                x: 911.0,
                y: 252.0,
                w: 156.0,
                h: 1581.0
            }
        );
        assert_eq!(about.actions, vec!["press"]);
    }

    #[test]
    fn a_portrait_only_app_on_a_turned_phone_keeps_its_portrait_layout() {
        let screen = Screen {
            orientation: Some("landscape_left".to_string()),
            ..screen()
        };
        let tree = tree(
            &settings(),
            &screen,
            TreeOptions {
                max_nodes: 64,
                max_depth: 4,
            },
        )
        .expect("parses");
        let general = tree.nodes[0]
            .children
            .iter()
            .find(|node| node.name == "General")
            .expect("found");
        assert_eq!(
            general.bounds,
            Bounds {
                x: 48.0,
                y: 900.0,
                w: 1110.0,
                h: 156.0
            }
        );
    }

    #[test]
    fn a_scroll_asked_for_upright_runs_across_the_framebuffer_of_a_turned_screen() {
        let tree = tree(
            &landscape(),
            &inner_screen(),
            TreeOptions {
                max_nodes: 64,
                max_depth: 4,
            },
        )
        .expect("parses");
        let list = tree.nodes[0]
            .children
            .iter()
            .find(|node| node.name == "List")
            .expect("found")
            .clone();
        let input = action_input(
            &list,
            "scroll",
            Some(&ace_json::json!({"dx": 0, "dy": 300})),
            Turn::Quarter,
        )
        .expect("acts");
        match input {
            ActInput::Swipe {
                x, to_x, y, to_y, ..
            } => {
                assert_eq!(y, to_y);
                assert_eq!(x - to_x, 300.0);
            }
            other => panic!("expected a swipe, got {other:?}"),
        }
    }
}
