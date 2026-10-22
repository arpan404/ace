use super::*;
use zbus::zvariant::{Array, StructureBuilder, Value};

fn gnome_record(streams: Vec<(u32, u32, Value<'static>)>) -> Value<'static> {
    let mut array = Array::new(&zbus::zvariant::Signature::try_from("(uuv)").unwrap());
    for (id, kind, data) in streams {
        let entry = StructureBuilder::new()
            .add_field(id)
            .add_field(kind)
            .add_field(Value::Value(Box::new(data)))
            .build()
            .unwrap();
        array.append(Value::Structure(entry)).unwrap();
    }
    let restore = StructureBuilder::new()
        .add_field(1i64)
        .add_field(2i64)
        .add_field(3u32)
        .add_field(false)
        .append_field(Value::Array(array))
        .build()
        .unwrap();
    Value::Structure(
        StructureBuilder::new()
            .add_field("GNOME")
            .add_field(1u32)
            .add_field(Value::Value(Box::new(Value::Structure(restore))))
            .build()
            .unwrap(),
    )
}

fn window(app: &str, title: &str) -> Value<'static> {
    Value::Structure(
        StructureBuilder::new()
            .add_field(app.to_owned())
            .add_field(title.to_owned())
            .build()
            .unwrap(),
    )
}

#[test]
fn a_window_gnome_recorded_is_named_by_its_desktop_id() {
    let record = gnome_record(vec![(
        0,
        SOURCE_WINDOW,
        window("org.gnome.Calculator.desktop", "Calculator"),
    )]);
    assert_eq!(
        parse_recorded(&record),
        Some(Recorded {
            app_id: "org.gnome.Calculator".into(),
            title: "Calculator".into()
        })
    );
}

#[test]
fn a_shared_screen_or_another_desktops_record_names_no_app() {
    let screen = gnome_record(vec![(0, SOURCE_MONITOR, Value::from("Meta-0"))]);
    assert_eq!(parse_recorded(&screen), None);
    let kde = Value::Structure(
        StructureBuilder::new()
            .add_field("KDE")
            .add_field(1u32)
            .add_field(2u32)
            .build()
            .unwrap(),
    );
    assert_eq!(parse_recorded(&kde), None);
    assert_eq!(parse_recorded(&Value::from("GNOME")), None);
}

#[test]
fn the_stream_type_decides_window_or_screen_and_a_screen_names_no_app() {
    let calculator = Recorded {
        app_id: "org.gnome.Calculator".into(),
        title: "Calculator".into(),
    };
    let both = SOURCE_WINDOW | SOURCE_MONITOR;
    let shared = Picked::new(Some(SOURCE_WINDOW), both, Some(calculator.clone()));
    assert!(!shared.display);
    assert_eq!(shared.json()["bundleId"], "org.gnome.Calculator");
    let screen = Picked::new(Some(SOURCE_MONITOR), both, Some(calculator.clone()));
    assert!(screen.display);
    assert_eq!(screen.json(), serde_json::json!({"source": "display"}));
    // A virtual source from a dialog offering both is a screen; from a dialog offering only
    // windows it is the window (xdg-desktop-portal-hyprland 1.3 reports windows so).
    assert!(Picked::new(Some(4), both, None).display);
    assert!(!Picked::new(Some(4), SOURCE_WINDOW, None).display);
}

#[test]
fn without_a_stream_type_an_unknown_pick_from_both_kinds_counts_as_a_screen() {
    assert!(!Picked::new(None, SOURCE_WINDOW, None).display);
    assert!(Picked::new(None, SOURCE_WINDOW | SOURCE_MONITOR, None).display);
    assert!(Picked::new(None, SOURCE_MONITOR, None).display);
    let recorded = Recorded {
        app_id: "org.gnome.TextEditor".into(),
        title: "Notes".into(),
    };
    assert!(!Picked::new(None, SOURCE_WINDOW | SOURCE_MONITOR, Some(recorded)).display);
}

#[test]
fn desktop_ids_drop_the_file_suffix_and_refuse_empty_names() {
    assert_eq!(
        desktop_id("org.gnome.Calculator.desktop").as_deref(),
        Some("org.gnome.Calculator")
    );
    assert_eq!(desktop_id("firefox").as_deref(), Some("firefox"));
    assert_eq!(desktop_id(" .desktop"), None);
}
