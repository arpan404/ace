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
    }
}
