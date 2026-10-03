use super::target::Target;
pub use crate::input::Action;
use crate::{
    coordinates::Mapping,
    errors::{Code, Error, Result},
    input::{plan, Event},
};
use windows::Win32::{
    Foundation::POINT,
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};
fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}
fn send(inputs: &[INPUT]) -> Result<()> {
    if unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) } != inputs.len() as u32 {
        return Err(Error::new(
            Code::Busy,
            "SendInput blocked, possibly UIPI or desktop changed",
        ));
    }
    Ok(())
}
fn point(target: &Target, map: &Mapping, x: f64, y: f64) -> Result<INPUT> {
    let (px, py) = map.physical(x, y)?;
    let hit = unsafe { GetAncestor(WindowFromPoint(POINT { x: px, y: py }), GA_ROOT) };
    if hit != target.window()? {
        return Err(Error::new(
            Code::Busy,
            "Target point is covered by another window",
        ));
    }
    let (dx, dy) = map.absolute(x, y)?;
    Ok(mouse(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        dx,
        dy,
        0,
    ))
}
pub fn inject(target: &Target, action: &Action) -> Result<()> {
    target.foreground()?;
    let map = target.mapping()?;
    let plan = plan(action)?;
    let mut events = Vec::with_capacity(plan.len() + 1);
    // Windows can scroll an inactive window under the pointer. Always place it in this target.
    if action.kind == "scroll" && action.x.is_none() && action.y.is_none() {
        let scale = map.dpi as f64 / 96.0;
        events.push(point(
            target,
            &map,
            map.target.w / scale / 2.0,
            map.target.h / scale / 2.0,
        )?);
    }
    for event in plan {
        events.push(match event {
            Event::Move { x, y } => point(target, &map, x, y)?,
            Event::Button { right, up } => mouse(
                match (right, up) {
                    (false, false) => MOUSEEVENTF_LEFTDOWN,
                    (false, true) => MOUSEEVENTF_LEFTUP,
                    (true, false) => MOUSEEVENTF_RIGHTDOWN,
                    (true, true) => MOUSEEVENTF_RIGHTUP,
                },
                0,
                0,
                0,
            ),
            Event::Wheel { horizontal, delta } => mouse(
                if horizontal {
                    MOUSEEVENTF_HWHEEL
                } else {
                    MOUSEEVENTF_WHEEL
                },
                0,
                0,
                delta as u32,
            ),
            Event::Key {
                code,
                unit,
                up,
                unicode,
                extended,
            } => {
                let mut flags = KEYBD_EVENT_FLAGS(0);
                if up {
                    flags |= KEYEVENTF_KEYUP;
                }
                if unicode {
                    flags |= KEYEVENTF_UNICODE;
                }
                if extended {
                    flags |= KEYEVENTF_EXTENDEDKEY;
                }
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(code),
                            wScan: unit,
                            dwFlags: flags,
                            ..Default::default()
                        },
                    },
                }
            }
        });
    }
    target.foreground()?;
    if let Err(error) = send(&events) {
        let releases: Vec<INPUT> = events
            .iter()
            .filter_map(|event| unsafe {
                if event.r#type == INPUT_KEYBOARD
                    && event.Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP)
                    || event.r#type == INPUT_MOUSE
                        && event.Anonymous.mi.dwFlags.0
                            & (MOUSEEVENTF_LEFTUP | MOUSEEVENTF_RIGHTUP).0
                            != 0
                {
                    Some(*event)
                } else {
                    None
                }
            })
            .collect();
        let _ = send(&releases);
        return Err(error);
    }
    Ok(())
}
