use super::{target::Target, uia::Automation, Apartment};
use windows::{
    core::w,
    Win32::{Foundation::HWND, UI::WindowsAndMessaging::*},
};
struct Window(HWND);
impl Drop for Window {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}
#[test]
#[ignore = "requires an interactive Windows desktop; run during the Windows manual plan"]
fn cached_edit_values_offer_set_value_only_when_writable() {
    let _apartment = Apartment::new().unwrap();
    let mut automation = Automation::new().unwrap();
    for readonly in [false, true] {
        let style = WS_OVERLAPPEDWINDOW
            | WS_VISIBLE
            | WINDOW_STYLE(if readonly { ES_READONLY as u32 } else { 0 });
        let window = Window(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("EDIT"),
                w!("cached value"),
                style,
                100,
                100,
                400,
                200,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        });
        let target = Target {
            kind: "window".into(),
            window_id: Some(window.0 .0 as usize as u64),
            display_id: None,
            bundle_id: None,
            bundle_ids: None,
        };
        let root = automation.tree(&target, 0, 1).unwrap().root.unwrap();
        assert_eq!(root.value.as_deref(), Some("cached value"));
        assert_eq!(root.actions.iter().any(|a| a == "setValue"), !readonly);
        let result = automation.act(
            &target,
            &root.r#ref,
            "setValue",
            Some(&serde_json::json!("updated")),
        );
        if readonly {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap()["fallback"], false);
            let changed = automation.tree(&target, 0, 1).unwrap().root.unwrap();
            assert_eq!(changed.value.as_deref(), Some("updated"));
        }
    }
}

#[test]
#[ignore = "moves the pointer on an interactive Windows desktop; run the manual plan"]
fn unsupported_invoke_on_an_edit_uses_a_reported_input_fallback() {
    let _apartment = Apartment::new().unwrap();
    let mut automation = Automation::new().unwrap();
    let window = Window(unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("EDIT"),
            w!("fallback edit"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            100,
            100,
            400,
            200,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    });
    let target = Target {
        kind: "window".into(),
        window_id: Some(window.0 .0 as usize as u64),
        display_id: None,
        bundle_id: None,
        bundle_ids: None,
    };
    assert!(
        unsafe { SetForegroundWindow(window.0) }.as_bool(),
        "interactive foreground required"
    );
    let root = automation.tree(&target, 0, 1).unwrap().root.unwrap();
    assert!(!root.actions.iter().any(|a| a == "press"));
    let result = automation.act(&target, &root.r#ref, "press", None).unwrap();
    assert_eq!(result["fallback"], true);
    assert_eq!(result["method"], "input");
    assert!(result["boundsCentre"]["x"].as_f64().unwrap() > 0.0);
    assert!(result["boundsCentre"]["y"].as_f64().unwrap() > 0.0);
}

#[test]
#[ignore = "requires an interactive Windows desktop; run during the Windows manual plan"]
fn a_destroyed_native_control_cannot_inherit_a_ref_when_its_runtime_cache_key_is_recycled() {
    use super::uia::same_live_control;
    use crate::references::References;
    use windows::Win32::{System::Com::*, UI::Accessibility::*};
    let _apartment = Apartment::new().unwrap();
    let api: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).unwrap() };
    fn edit(text: &windows::core::HSTRING) -> Window {
        Window(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("EDIT"),
                text,
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                100,
                100,
                400,
                200,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        })
    }
    let first = edit(&"first".into());
    let old = unsafe { api.ElementFromHandle(first.0).unwrap() };
    let mut refs = References::new(4);
    let original = refs.retain("recycled-runtime-key".into(), old.clone());
    assert_eq!(
        refs.retain_if_same("recycled-runtime-key".into(), old.clone(), |a, b| {
            same_live_control(&api, a, b)
        }),
        original
    );
    drop(first);
    // Keep the old COM element but destroy the actual control before creating the replacement.
    assert!(unsafe { old.CurrentProcessId() }.is_err());
    let second = edit(&"replacement".into());
    let current = unsafe { api.ElementFromHandle(second.0).unwrap() };
    let replacement = refs.retain_if_same("recycled-runtime-key".into(), current, |a, b| {
        same_live_control(&api, a, b)
    });
    assert_ne!(original, replacement);
    assert!(refs.get(&original).is_none());
    let current = refs.get(&replacement).unwrap();
    assert_eq!(
        unsafe {
            current
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .unwrap()
                .CurrentValue()
                .unwrap()
                .to_string()
        },
        "replacement"
    );
}
