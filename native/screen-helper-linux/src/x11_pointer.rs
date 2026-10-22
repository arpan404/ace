//! Pointer input on X11 for the person at a live view (ADR 0049, "X11 pointer input").
//!
//! XTest events carry no recipient: the server delivers them wherever a physical click at that
//! point would go. So a click is sent only when, with the server grabbed so nothing changes in
//! between, the shared window is still the same app's window and the active one, the point is
//! inside it, the window is the topmost one there (no other app's window or overlay covers
//! it), no other client holds the pointer, and no other client has a passive grab on the root
//! window that would take this button anywhere on the screen. What remains is exactly what the
//! person's own mouse would do there.
//!
//! Agents never get this: their pointer input is refused, and they act through accessibility.
use crate::{
    policy::point,
    protocol::{Fault, Result, internal},
    x11::{Window, X11},
};
use std::time::Duration;
use x11rb::{connection::Connection, protocol::xproto::*};

/// X11 core pointer buttons.
fn button_code(button: &str) -> Result<u8> {
    match button {
        "left" => Ok(1),
        "middle" => Ok(2),
        "right" => Ok(3),
        _ => Err(Fault::new("bounds", "Unknown button")),
    }
}

/// Wheel clicks for a scroll in points: one notch per 40 points, at least one, at most 20.
pub fn wheel_steps(delta: f64) -> u32 {
    if delta == 0. {
        return 0;
    }
    ((delta.abs() / 40.).round() as u32).clamp(1, 20)
}

fn agent_refused() -> Fault {
    Fault::new(
        "not_supported",
        "X11 pointer input is only for the person at a live view; use a direct accessibility action",
    )
    .phase("rejected-before-dispatch")
}

impl X11 {
    /// Runs `deliver` with the server grabbed, so the checks it makes still hold when its
    /// events are queued.
    fn grabbed<T>(&self, deliver: impl FnOnce() -> Result<T>) -> Result<T> {
        self.conn
            .grab_server()
            .map_err(internal)?
            .check()
            .map_err(internal)?;
        let result = deliver();
        let released = self
            .conn
            .ungrab_server()
            .map_err(internal)
            .and_then(|cookie| cookie.check().map_err(internal));
        let _ = self.conn.flush();
        let value = result?;
        released?;
        Ok(value)
    }

    /// The root point for a window point, after every delivery check.
    fn deliverable(&self, w: &Window, x: f64, y: f64, button: u8) -> Result<(i16, i16)> {
        let live = self.check(w)?;
        point(
            x,
            y,
            live.bounds.w.max(0) as u32,
            live.bounds.h.max(0) as u32,
        )?;
        let rx = live.bounds.x + x.floor() as i32;
        let ry = live.bounds.y + y.floor() as i32;
        let (rx, ry) = (
            i16::try_from(rx).map_err(|_| Fault::new("bounds", "Point is off the screen"))?,
            i16::try_from(ry).map_err(|_| Fault::new("bounds", "Point is off the screen"))?,
        );
        self.topmost_at(w.id, rx, ry)?;
        self.pointer_free()?;
        self.root_button_free(button)?;
        Ok((rx, ry))
    }

    /// The window under a root point, walking down from the root through each child
    /// containing it, must reach `target` before any other window ends the walk.
    fn topmost_at(&self, target: u32, x: i16, y: i16) -> Result<()> {
        let mut parent = self.root;
        for _ in 0..32 {
            let child = self
                .conn
                .translate_coordinates(self.root, parent, x, y)
                .map_err(internal)?
                .reply()
                .map_err(internal)?
                .child;
            if child == target {
                return Ok(());
            }
            if child == x11rb::NONE {
                break;
            }
            parent = child;
        }
        Err(Fault::new(
            "busy",
            "Another window covers that point of the shared window",
        )
        .phase("rejected-before-dispatch"))
    }

    /// No other client holds the pointer (an open menu, a screen locker, a drag).
    fn pointer_free(&self) -> Result<()> {
        let status = self
            .conn
            .grab_pointer(
                false,
                self.root,
                EventMask::NO_EVENT,
                GrabMode::ASYNC,
                GrabMode::ASYNC,
                x11rb::NONE,
                x11rb::NONE,
                x11rb::CURRENT_TIME,
            )
            .map_err(internal)?
            .reply()
            .map_err(internal)?
            .status;
        if status != GrabStatus::SUCCESS {
            return Err(Fault::new("busy", "Another app holds the pointer")
                .phase("rejected-before-dispatch"));
        }
        self.conn
            .ungrab_pointer(x11rb::CURRENT_TIME)
            .map_err(internal)?
            .check()
            .map_err(internal)
    }

    /// No other client grabs this button on the root, where it would take every click.
    fn root_button_free(&self, button: u8) -> Result<()> {
        let probe = self
            .conn
            .grab_button(
                false,
                self.root,
                EventMask::BUTTON_PRESS,
                GrabMode::ASYNC,
                GrabMode::ASYNC,
                x11rb::NONE,
                x11rb::NONE,
                ButtonIndex::from(button),
                ModMask::from(0u16),
            )
            .map_err(internal)?
            .check();
        if probe.is_err() {
            return Err(Fault::new(
                "busy",
                "Another app intercepts clicks anywhere on this desktop",
            )
            .phase("rejected-before-dispatch"));
        }
        self.conn
            .ungrab_button(ButtonIndex::from(button), self.root, ModMask::from(0u16))
            .map_err(internal)?
            .check()
            .map_err(internal)
    }

    pub fn motion(&self, w: &Window, x: f64, y: f64, person: bool) -> Result<()> {
        if !person {
            let live = self.check(w)?;
            point(x, y, live.bounds.w as u32, live.bounds.h as u32)?;
            return Err(agent_refused());
        }
        let live = self.check(w)?;
        point(
            x,
            y,
            live.bounds.w.max(0) as u32,
            live.bounds.h.max(0) as u32,
        )?;
        let (rx, ry) = (
            live.bounds.x + x.floor() as i32,
            live.bounds.y + y.floor() as i32,
        );
        self.fake(MOTION_NOTIFY_EVENT, 0, rx as i16, ry as i16)
    }

    pub fn click(&self, w: &Window, x: f64, y: f64, button: &str, person: bool) -> Result<()> {
        let code = button_code(button)?;
        if !person {
            let live = self.check(w)?;
            point(x, y, live.bounds.w as u32, live.bounds.h as u32)?;
            return Err(agent_refused());
        }
        self.grabbed(|| {
            let (rx, ry) = self.deliverable(w, x, y, code)?;
            self.fake(MOTION_NOTIFY_EVENT, 0, rx, ry)?;
            self.fake(BUTTON_PRESS_EVENT, code, rx, ry)?;
            self.fake(BUTTON_RELEASE_EVENT, code, rx, ry)
        })
    }

    /// Press at one point, move, release at another. After the press the pointer is
    /// implicitly grabbed by the window under it, so the moves and the release reach it.
    pub fn drag(
        &self,
        w: &Window,
        from: (f64, f64),
        to: (f64, f64),
        duration: Duration,
        person: bool,
    ) -> Result<()> {
        if !person {
            let live = self.check(w)?;
            point(from.0, from.1, live.bounds.w as u32, live.bounds.h as u32)?;
            point(to.0, to.1, live.bounds.w as u32, live.bounds.h as u32)?;
            return Err(agent_refused());
        }
        let ((sx, sy), (ex, ey)) = self.grabbed(|| {
            let end = self.deliverable(w, to.0, to.1, 1)?;
            let start = self.deliverable(w, from.0, from.1, 1)?;
            self.fake(MOTION_NOTIFY_EVENT, 0, start.0, start.1)?;
            self.fake(BUTTON_PRESS_EVENT, 1, start.0, start.1)?;
            Ok((start, end))
        })?;
        let steps = 12;
        let mut moved = Ok(());
        for step in 1..=steps {
            std::thread::sleep(duration / steps);
            let t = f64::from(step) / f64::from(steps);
            let x = f64::from(sx) + (f64::from(ex) - f64::from(sx)) * t;
            let y = f64::from(sy) + (f64::from(ey) - f64::from(sy)) * t;
            moved = self.fake(MOTION_NOTIFY_EVENT, 0, x.round() as i16, y.round() as i16);
            if moved.is_err() {
                break;
            }
        }
        // Always release, even when a move failed.
        let released = self.fake(BUTTON_RELEASE_EVENT, 1, ex, ey);
        moved.and(released)
    }

    /// Wheel notches at a point of the window, or where the pointer is.
    pub fn scroll(
        &self,
        w: &Window,
        at: Option<(f64, f64)>,
        dx: f64,
        dy: f64,
        person: bool,
    ) -> Result<()> {
        self.check(w)?;
        if !dx.is_finite() || !dy.is_finite() || dx.abs() > 1000. || dy.abs() > 1000. {
            return Err(Fault::new("bounds", "Scroll exceeds limit"));
        }
        if dx == 0. && dy == 0. {
            return Ok(());
        }
        if !person {
            return Err(agent_refused());
        }
        let (x, y) = match at {
            Some(at) => at,
            None => {
                let live = self.check(w)?;
                let pointer = self
                    .conn
                    .query_pointer(self.root)
                    .map_err(internal)?
                    .reply()
                    .map_err(internal)?;
                (
                    f64::from(pointer.root_x) - f64::from(live.bounds.x),
                    f64::from(pointer.root_y) - f64::from(live.bounds.y),
                )
            }
        };
        let mut notches = Vec::new();
        let vertical = if dy > 0. { 5 } else { 4 };
        let horizontal = if dx > 0. { 7 } else { 6 };
        notches.extend(std::iter::repeat_n(vertical, wheel_steps(dy) as usize));
        notches.extend(std::iter::repeat_n(horizontal, wheel_steps(dx) as usize));
        self.grabbed(|| {
            let (rx, ry) = self.deliverable(w, x, y, notches[0])?;
            if let Some(other) = notches.iter().find(|b| **b != notches[0]) {
                self.root_button_free(*other)?;
            }
            self.fake(MOTION_NOTIFY_EVENT, 0, rx, ry)?;
            for button in &notches {
                self.fake(BUTTON_PRESS_EVENT, *button, rx, ry)?;
                self.fake(BUTTON_RELEASE_EVENT, *button, rx, ry)?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::wheel_steps;

    #[test]
    fn a_scroll_becomes_whole_wheel_notches_within_limits() {
        assert_eq!(wheel_steps(0.), 0);
        assert_eq!(wheel_steps(3.), 1);
        assert_eq!(wheel_steps(-120.), 3);
        assert_eq!(wheel_steps(1000.), 20);
    }
}
