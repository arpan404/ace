use super::*;

fn facts(control_type: i32) -> Facts {
    Facts {
        control_type,
        enabled: true,
        ..Facts::default()
    }
}

fn node(id: u64, depth: usize, frame: Rect, actionable: bool) -> Node {
    Node {
        id,
        depth,
        role: "button".into(),
        flags: vec![],
        name: None,
        value: None,
        detail: None,
        placeholder: None,
        actions: vec![],
        frame: Some(frame),
        actionable,
    }
}

#[test]
fn controls_read_with_the_words_the_macos_engine_uses() {
    let mut edit = facts(control::EDIT);
    assert_eq!(role_name(&edit), "text field");
    edit.multi_line = true;
    assert_eq!(role_name(&edit), "text area");
    edit.password = true;
    assert_eq!(role_name(&edit), "secure text field");
    let mut item = facts(control::MENU_ITEM);
    item.in_menu_bar = true;
    assert_eq!(role_name(&item), "menu bar item");
    assert_eq!(role_name(&facts(control::LIST_ITEM)), "row");
    assert_eq!(role_name(&facts(control::PANE)), "group");
    let mut window = facts(control::WINDOW);
    window.dialog = true;
    assert_eq!(role_name(&window), "dialog");
    let mut document = facts(control::DOCUMENT);
    document.value_writable = Some(true);
    assert_eq!(role_name(&document), "text area");
}

#[test]
fn flags_report_state_the_model_acts_on() {
    let mut check = facts(control::CHECK_BOX);
    check.toggle = Some(TOGGLE_ON);
    check.focused = true;
    assert_eq!(flags(&check), ["focused", "on"]);
    let mut combo = facts(control::COMBO_BOX);
    combo.expand = Some(0);
    combo.enabled = false;
    assert_eq!(flags(&combo), ["disabled", "collapsed"]);
    let mut field = facts(control::EDIT);
    field.value_writable = Some(false);
    assert_eq!(flags(&field), ["read-only"]);
    let mut leaf = facts(control::TREE_ITEM);
    leaf.expand = Some(LEAF);
    leaf.selected = Some(true);
    assert_eq!(flags(&leaf), ["selected"]);
}

#[test]
fn listed_actions_are_only_those_beyond_the_plain_click() {
    let mut item = facts(control::LIST_ITEM);
    item.invoke = true;
    item.selected = Some(false);
    item.default_action = Some("Double Click".into());
    assert_eq!(readable_actions(&item), ["select", "double click"]);
    let mut button = facts(control::BUTTON);
    button.invoke = true;
    button.default_action = Some("Press".into());
    assert!(readable_actions(&button).is_empty());
    let mut tree = facts(control::TREE_ITEM);
    tree.expand = Some(EXPANDED);
    assert_eq!(readable_actions(&tree), ["collapse"]);
    let mut pane = facts(control::PANE);
    pane.default_action = Some("Open".into());
    assert!(readable_actions(&pane).is_empty());
}

#[test]
fn unnamed_wrappers_fold_and_empty_ones_drop() {
    assert_eq!(keep(control::PANE, false, false, 3), Keep::Fold);
    assert_eq!(keep(control::PANE, false, false, 1), Keep::Fold);
    assert_eq!(keep(control::PANE, false, false, 0), Keep::Drop);
    assert_eq!(keep(control::PANE, false, true, 0), Keep::Line);
    assert_eq!(keep(control::LIST, false, false, 0), Keep::Line);
    assert_eq!(keep(control::IMAGE, false, false, 2), Keep::Line);
    assert!(is_noise(control::TITLE_BAR) && is_noise(control::SCROLL_BAR));
}

#[test]
fn text_is_said_once_and_passwords_are_never_shown() {
    let mut label = facts(control::TEXT);
    label.value = Some("Pressed 3".into());
    assert_eq!(texts(&label), (Some("Pressed 3".into()), None, None));
    let mut field = facts(control::EDIT);
    field.name = Some("Name:".into());
    field.value = Some("Ada".into());
    field.help = Some("Name:".into());
    assert_eq!(
        texts(&field),
        (Some("Name:".into()), Some("Ada".into()), None)
    );
    field.password = true;
    field.value = Some("hunter2".into());
    assert_eq!(texts(&field).1, None);
    let mut long = facts(control::DOCUMENT);
    long.value = Some("x".repeat(3000));
    assert_eq!(texts(&long).1.unwrap().chars().count(), 2001);
}

#[test]
fn edits_and_toggles_are_actionable_and_plain_text_is_not() {
    assert!(is_actionable(&facts(control::EDIT)));
    assert!(is_actionable(&facts(control::BUTTON)));
    assert!(!is_actionable(&facts(control::TEXT)));
    let mut leaf = facts(control::TREE_ITEM);
    leaf.expand = Some(LEAF);
    assert!(is_actionable(&leaf));
    let mut pane = facts(control::PANE);
    pane.expand = Some(LEAF);
    assert!(!is_actionable(&pane));
}

#[test]
fn a_point_hits_the_innermost_actionable_element() {
    let nodes = [
        node(
            1,
            0,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 400.0,
                h: 300.0,
            },
            true,
        ),
        node(
            2,
            1,
            Rect {
                x: 10.0,
                y: 10.0,
                w: 100.0,
                h: 30.0,
            },
            true,
        ),
        node(
            3,
            2,
            Rect {
                x: 12.0,
                y: 12.0,
                w: 20.0,
                h: 20.0,
            },
            false,
        ),
    ];
    assert_eq!(hit(&nodes, 15.0, 15.0).map(|n| n.id), Some(2));
    assert_eq!(hit(&nodes, 300.0, 200.0).map(|n| n.id), Some(1));
    assert_eq!(hit(&nodes, 500.0, 200.0).map(|n| n.id), None);
}

#[test]
fn a_recycled_row_changes_the_identity_of_the_controls_inside_it() {
    let mut delete = facts(control::BUTTON);
    delete.name = Some("Delete".into());
    assert_ne!(
        identity(&delete, Some("Alice")),
        identity(&delete, Some("Bob"))
    );
    assert_eq!(
        identity(&delete, Some("Alice")),
        identity(&delete, Some("Alice"))
    );
    let mut renamed = delete.clone();
    renamed.name = Some("Archive".into());
    assert_ne!(identity(&delete, None), identity(&renamed, None));
    // A field keeps its id while its label or text changes; so does plain text.
    let mut field = facts(control::EDIT);
    field.name = Some("Name:".into());
    let mut relabelled = field.clone();
    relabelled.name = Some("Full name:".into());
    assert_eq!(identity(&field, None), identity(&relabelled, None));
    let mut text = facts(control::TEXT);
    text.name = Some("Pressed 0".into());
    let mut later = text.clone();
    later.name = Some("Pressed 1".into());
    assert_eq!(identity(&text, None), identity(&later, None));
    assert!(is_row(control::LIST_ITEM) && !is_row(control::BUTTON));
}
