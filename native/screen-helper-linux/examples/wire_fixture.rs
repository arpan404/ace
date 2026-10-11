//! Native semantic encoding fixture, without requiring an AT-SPI bus.
use ace_screen_helper_linux::{accessibility::{bound_node, Bounds, Node}, references::References};
fn main() {
    let mut refs = References::new(2);
    let reference = refs.retain(":1.42/org/a11y/atspi/accessible/1".into(), "control");
    let mut node = Node { reference, role: "entry".into(), name: "👨‍👩‍👧‍👦".repeat(100), value: Some("a\u{301}".repeat(600)), description: "label".repeat(600), bounds: Bounds { x: 0, y: 0, w: 20, h: 20 }, states: vec![], actions: vec!["setValue".into()], children: vec![] };
    let truncated = bound_node(&mut node);
    println!("{}", serde_json::json!({"tree": {"tree":node,"truncated":truncated}, "find": {"nodes":[node],"truncated":truncated}}));
}
