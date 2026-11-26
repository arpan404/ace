// SPDX-License-Identifier: Apache-2.0
//! `SimRefs` (`sim-refs.ts`): short refs that survive reads, one numbering per
//! agent and device, and the two caps.
//!
//! `sim-refs.ts` has no test file of its own (behaviour.md §5 lists none), so
//! these cases are the module's only guard.

use super::{Bounds, MAX_ELEMENTS, MAX_SCOPES, Node, SimRefs, bare, is_ref};
use ace_json::JsString;

fn node(reference: &str, role: &str, name: &str, actions: &[&str]) -> Node {
    Node {
        reference: JsString::from(reference),
        role: JsString::from(role),
        name: JsString::from(name),
        value: None,
        secondary_actions: Vec::new(),
        description: None,
        bounds: Bounds {
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 50.0,
        },
        states: Vec::new(),
        actions: actions.iter().map(|action| (*action).to_owned()).collect(),
        children: Vec::new(),
    }
}

fn actionable(reference: &str) -> Node {
    node(reference, "Button", "Save", &["press"])
}

#[test]
fn an_actionable_node_gets_a_ref_and_the_rest_do_not() {
    let mut refs = SimRefs::new();
    let labelled = refs.label(
        "agent-1",
        "ios:AAAA",
        &[node("r1", "Window", "App", &[]), actionable("r2")],
    );
    assert_eq!(labelled.nodes[0].reference, None);
    assert_eq!(labelled.nodes[1].reference.as_deref(), Some("@e1"));
    assert!(labelled.seen.contains_key("e1"));
}

#[test]
fn a_ref_survives_a_read_while_its_element_stays() {
    let mut refs = SimRefs::new();
    let first = refs.label("agent-1", "ios:AAAA", &[actionable("r1")]);
    assert_eq!(first.nodes[0].reference.as_deref(), Some("@e1"));

    // The same platform ref: the same agent ref.
    let second = refs.label("agent-1", "ios:AAAA", &[actionable("r1")]);
    assert_eq!(second.nodes[0].reference.as_deref(), Some("@e1"));

    // A re-numbered platform ref, same role, name and frame: still `@e1`.
    let third = refs.label("agent-1", "ios:AAAA", &[actionable("r99")]);
    assert_eq!(third.nodes[0].reference.as_deref(), Some("@e1"));
    assert_eq!(
        refs.element("agent-1", "ios:AAAA", "@e1")
            .map(|element| element.reference.as_str()),
        Some("r99"),
        "the element is remembered as this read saw it"
    );
}

#[test]
fn a_ref_this_agent_was_never_given_is_unknown() {
    let mut refs = SimRefs::new();
    refs.label("agent-1", "ios:AAAA", &[actionable("r1")]);
    assert!(refs.element("agent-1", "ios:AAAA", "@e9").is_none());
    assert!(
        refs.element("agent-2", "ios:AAAA", "@e1").is_none(),
        "another agent"
    );
    assert!(
        refs.element("agent-1", "android:emulator-5554", "@e1")
            .is_none()
    );
    // `e1` and `@e1` are the same ref.
    assert!(refs.element("agent-1", "ios:AAAA", "e1").is_some());
}

#[test]
fn each_agent_and_device_numbers_separately() {
    let mut refs = SimRefs::new();
    let one = refs.label("agent-1", "ios:AAAA", &[actionable("r1")]);
    let two = refs.label("agent-2", "ios:AAAA", &[actionable("r1")]);
    let other = refs.label("agent-1", "android:emulator-5554", &[actionable("r1")]);
    assert_eq!(one.nodes[0].reference.as_deref(), Some("@e1"));
    assert_eq!(two.nodes[0].reference.as_deref(), Some("@e1"));
    assert_eq!(other.nodes[0].reference.as_deref(), Some("@e1"));
}

#[test]
fn two_actionable_elements_never_share_a_ref() {
    let mut refs = SimRefs::new();
    // The same role, name and frame twice: the second cannot reuse the first's id.
    let labelled = refs.label("agent-1", "ios:AAAA", &[actionable("r1"), actionable("r2")]);
    assert_eq!(labelled.nodes[0].reference.as_deref(), Some("@e1"));
    assert_eq!(labelled.nodes[1].reference.as_deref(), Some("@e2"));
}

#[test]
fn the_element_cap_evicts_the_refs_seen_longest_ago() {
    let mut refs = SimRefs::new();
    let nodes: Vec<Node> = (0..=MAX_ELEMENTS)
        .map(|index| {
            let mut node = actionable(&format!("r{index}"));
            node.name = JsString::from(format!("row {index}"));
            node
        })
        .collect();
    let labelled = refs.label("agent-1", "ios:AAAA", &nodes);
    assert_eq!(labelled.seen.len(), MAX_ELEMENTS + 1);
    // The oldest is gone; the newest is kept.
    assert!(refs.element("agent-1", "ios:AAAA", "@e1").is_none());
    assert!(
        refs.element("agent-1", "ios:AAAA", &format!("@e{}", MAX_ELEMENTS + 1))
            .is_some()
    );
}

#[test]
fn the_scope_cap_evicts_the_agent_idle_longest() {
    let mut refs = SimRefs::new();
    for index in 0..=MAX_SCOPES {
        refs.label(&format!("agent-{index}"), "ios:AAAA", &[actionable("r1")]);
    }
    assert!(refs.element("agent-0", "ios:AAAA", "@e1").is_none());
    assert!(
        refs.element(&format!("agent-{MAX_SCOPES}"), "ios:AAAA", "@e1")
            .is_some()
    );
    // Reading an old scope again keeps it alive.
    refs.label("agent-1", "ios:AAAA", &[actionable("r1")]);
    refs.label("agent-new", "ios:AAAA", &[actionable("r1")]);
    assert!(refs.element("agent-1", "ios:AAAA", "@e1").is_some());
}

#[test]
fn a_ref_is_at_e_then_one_to_seven_digits_without_a_leading_zero() {
    for good in ["@e1", "e1", "@e3", "@e9999999"] {
        assert!(is_ref(good), "{good}");
    }
    for bad in ["e0", "@e01", "e", "@", "e12345678", "x1", "@e1a", " e1"] {
        assert!(!is_ref(bad), "{bad}");
    }
    assert_eq!(bare("@e3"), "e3");
    assert_eq!(bare("e3"), "e3");
}

#[test]
fn the_fingerprint_is_the_type_script_json() {
    // `JSON.stringify([role, name, x, y, w, h])`, numbers as JavaScript writes them.
    let print = super::fingerprint(
        &JsString::from("Button"),
        &JsString::from("Save"),
        Bounds {
            x: 0.5,
            y: 10.0,
            w: 100.0,
            h: 50.25,
        },
    );
    assert_eq!(print, "[\"Button\",\"Save\",0.5,10,100,50.25]");
}
