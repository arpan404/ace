use ace_screen_helper_linux::accessibility::{Bounds, Node, bound_node};
#[test]
fn long_fields_fit_the_shared_wire_limits_and_report_truncation() {
    let mut node = Node {
        reference: "u1".into(),
        role: "button".into(),
        name: "x".repeat(1025),
        value: Some("👨‍👩‍👧‍👦".repeat(100)),
        description: "a\u{301}".repeat(300),
        bounds: Bounds::default(),
        states: vec![],
        actions: vec![],
        children: vec![],
    };
    assert!(bound_node(&mut node));
    assert_eq!(node.name.chars().count(), 256);
    assert_eq!(node.value.as_ref().unwrap().chars().count(), 512);
    assert_eq!(node.description.chars().count(), 256);
    assert!(!bound_node(&mut node));
}
#[test]
fn public_refs_hide_dbus_paths_and_cannot_alias_evicted_or_retargeted_entries() {
    use ace_screen_helper_linux::references::References;
    let mut refs = References::new(1);
    let object = ":1.42/org/a11y/atspi/accessible/1";
    let first = refs.retain(object.into(), "first window");
    assert!(
        first.len() <= 64
            && first
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    );
    assert_eq!(refs.retain(object.into(), "first window"), first);
    refs.retain("other object".into(), "other window");
    assert!(refs.get(&first).is_none());
    let replacement = refs.retain(object.into(), "replacement window");
    assert_ne!(first, replacement);
    refs.clear();
    assert!(refs.get(&replacement).is_none());
    assert_ne!(replacement, refs.retain(object.into(), "next target"));
}

#[test]
fn destroyed_objects_do_not_reuse_their_saved_reference() {
    use ace_screen_helper_linux::references::References;
    let mut refs = References::new(2);
    let first = refs.retain("object".into(), "old");
    refs.remove("object");
    let replacement = refs.retain("object".into(), "new");
    assert!(refs.get(&first).is_none());
    assert_ne!(first, replacement);
    assert_eq!(refs.get(&replacement), Some(&"new"));
}
