use super::*;

fn enabled() -> States {
    States {
        sensitive: true,
        enabled: true,
        showing: true,
        ..States::default()
    }
}

#[test]
fn buttons_read_as_the_macos_engine_names_them() {
    let states = enabled();
    assert_eq!(role_name("push button", &states, false), "button");
    assert_eq!(role_name("frame", &states, false), "window");
    assert_eq!(role_name("menu", &states, true), "menu bar item");
    let editor = States {
        editable: true,
        multi_line: true,
        ..enabled()
    };
    assert_eq!(role_name("text", &editor, false), "text area");
    let field = States {
        editable: true,
        ..enabled()
    };
    assert_eq!(role_name("text", &field, false), "text field");
}

#[test]
fn gtk4_window_extents_land_inside_the_shadow_margin() {
    // A 700×520 X window whose 690×510 content reports itself at (-5, -5).
    let content = Rect {
        x: -5.0,
        y: -5.0,
        w: 690.0,
        h: 510.0,
    };
    let (dx, dy) = content_offset((700.0, 520.0), content);
    // The content's left edge is then drawn 5 px into the window.
    assert_eq!((-5.0 - dx, -5.0 - dy), (5.0, 5.0));
}

#[test]
fn toggles_say_on_or_off_and_insensitive_controls_say_disabled() {
    let on = States {
        checked: true,
        ..enabled()
    };
    assert_eq!(flags("check box", &on), vec!["on"]);
    assert_eq!(flags("toggle button", &enabled()), vec!["off"]);
    let off = States {
        sensitive: false,
        ..enabled()
    };
    assert_eq!(flags("push button", &off), vec!["disabled"]);
    // GTK4 sets SENSITIVE but never ENABLED on usable controls.
    let gtk4 = States {
        enabled: false,
        ..enabled()
    };
    assert!(flags("push button", &gtk4).is_empty());
    let password = States {
        focused: true,
        ..enabled()
    };
    assert_eq!(flags("password text", &password), vec!["focused", "secure"]);
}

#[test]
fn a_plain_click_is_never_listed_and_windows_list_no_actions() {
    let actions: Vec<String> = ["click", "menu.popup", "clipboard.copy"].map(String::from).to_vec();
    assert_eq!(readable_actions("text", &actions), vec!["menu.popup", "clipboard.copy"]);
    assert!(readable_actions("frame", &["window.close".into()]).is_empty());
    let many: Vec<String> = (0..10).map(|i| format!("a{i}")).collect();
    assert_eq!(readable_actions("push button", &many).len(), 6);
}

#[test]
fn clicking_prefers_click_over_other_press_like_actions() {
    let actions: Vec<String> = ["activate", "click"].map(String::from).to_vec();
    assert_eq!(press_action(&actions), Some(1));
    assert_eq!(press_action(&["expand".into()]), None);
}

#[test]
fn unlabelled_wrappers_fold_into_their_only_child_and_empty_ones_vanish() {
    assert_eq!(keep("panel", false, false, 1), Keep::Fold);
    assert_eq!(keep("panel", false, false, 0), Keep::Drop);
    assert_eq!(keep("panel", false, false, 3), Keep::Fold);
    assert_eq!(keep("table", false, false, 3), Keep::Line);
    assert_eq!(keep("unknown", false, false, 3), Keep::Line);
    assert_eq!(keep("push button", true, true, 0), Keep::Line);
    assert_eq!(keep("scroll pane", false, false, 1), Keep::Line);
}

#[test]
fn labels_carry_their_text_as_the_name_and_nothing_repeats() {
    let (name, value, detail) = texts("label", None, None, Some("42".into()));
    assert_eq!((name.as_deref(), value, detail), (Some("42"), None, None));
    let (name, value, detail) = texts("push button", Some("7".into()), Some("7".into()), Some("7".into()));
    assert_eq!((name.as_deref(), value, detail), (Some("7"), None, None));
}

#[test]
fn conditions_search_role_name_and_value_case_insensitively() {
    let node = Node {
        id: 3,
        depth: 1,
        role: "text field".into(),
        flags: vec![],
        name: Some("Search".into()),
        value: Some("Hello World".into()),
        detail: None,
        placeholder: None,
        actions: vec![],
        frame: None,
        actionable: true,
    };
    assert!(node.search_line().contains("hello world"));
    assert_eq!(node.label(), "3 text field \"Search\"");
    let json = node.json();
    assert_eq!(json["value"], "Hello World");
    assert!(json.get("flags").is_none());
}
