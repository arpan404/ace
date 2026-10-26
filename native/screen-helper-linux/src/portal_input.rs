//! A person's input through the RemoteDesktop portal, in the shared stream's points.
//!
//! The portal's input devices are virtual ones the compositor creates on first use. On a
//! desktop with no real pointer or keyboard (headless GNOME, a remote session) the seat has
//! neither until then, so the first events go nowhere: apps bind the new keyboard and pointer
//! only after they appear, the first absolute motion lands on one axis only, and the pointer
//! is born in the top-left corner, where GNOME's hot corner opens the overview and swallows
//! the next click. Each device is therefore woken once per session before it carries the
//! person's input: a lone Shift tap for the keyboard, and two small relative moves away from
//! the corner for the pointer, then a pause for apps to bind them.
use crate::{
    policy::point,
    portal::{Portal, dict},
    protocol::{Result, internal},
};
use std::{sync::atomic::Ordering, time::Duration};
use zbus::zvariant::OwnedValue;

const SETTLE: Duration = Duration::from_millis(150);
/// evdev KEY_LEFTSHIFT: pressing and releasing it alone does nothing in apps.
const LEFT_SHIFT: i32 = 42;

impl Portal {
    /// The size input points are checked against: the newest picture's, else the stream's.
    fn input_size(&self) -> (u32, u32) {
        let shown = self.shown.load(Ordering::Acquire);
        let (w, h) = ((shown >> 32) as u32, shown as u32);
        if w > 0 && h > 0 { (w, h) } else { self.size }
    }
    async fn call(
        &self,
        method: &str,
        body: impl serde::Serialize + zbus::zvariant::DynamicType,
    ) -> Result<()> {
        self.proxy("RemoteDesktop")
            .await?
            .call::<_, _, ()>(method, &body)
            .await
            .map_err(internal)
    }
    async fn wake_pointer(&self) -> Result<()> {
        if self.pointer_ready.load(Ordering::Acquire) {
            return Ok(());
        }
        let path = self.path()?;
        self.call("NotifyPointerMotion", (path, dict([]), 8f64, 0f64))
            .await?;
        self.call("NotifyPointerMotion", (path, dict([]), 0f64, 8f64))
            .await?;
        tokio::time::sleep(SETTLE).await;
        self.pointer_ready.store(true, Ordering::Release);
        Ok(())
    }
    async fn wake_keyboard(&self) -> Result<()> {
        if self.keyboard_ready.load(Ordering::Acquire) {
            return Ok(());
        }
        let path = self.path()?;
        self.call("NotifyKeyboardKeycode", (path, dict([]), LEFT_SHIFT, 1u32))
            .await?;
        self.call("NotifyKeyboardKeycode", (path, dict([]), LEFT_SHIFT, 0u32))
            .await?;
        tokio::time::sleep(SETTLE).await;
        self.keyboard_ready.store(true, Ordering::Release);
        Ok(())
    }
    /// Both devices exist before anything depends on them. On a desktop whose only keyboard is
    /// this session's, no window is active until that keyboard appears.
    pub async fn wake(&self) -> Result<()> {
        if self.require(1).is_ok() {
            self.wake_keyboard().await?;
        }
        if self.require(2).is_ok() {
            self.wake_pointer().await?;
        }
        Ok(())
    }
    pub async fn motion(&self, x: f64, y: f64) -> Result<()> {
        // Refused first: a watch-only view says why, not that the point is out of bounds.
        self.require(2)?;
        let (w, h) = self.input_size();
        point(x, y, w, h)?;
        let first = !self.pointer_ready.load(Ordering::Acquire);
        self.wake_pointer().await?;
        let path = self.path()?;
        self.call(
            "NotifyPointerMotionAbsolute",
            (path, dict([]), self.node, x, y),
        )
        .await?;
        if first {
            // The first absolute event after the pointer appears can keep one old axis.
            tokio::time::sleep(Duration::from_millis(30)).await;
            self.call(
                "NotifyPointerMotionAbsolute",
                (path, dict([]), self.node, x, y),
            )
            .await?;
        }
        Ok(())
    }
    pub async fn button(&self, button: &str, pressed: bool) -> Result<()> {
        self.require(2)?;
        let code: i32 = match button {
            "left" => 0x110,
            "right" => 0x111,
            "middle" => 0x112,
            _ => return Err(crate::protocol::Fault::new("bounds", "Unknown button")),
        };
        self.wake_pointer().await?;
        self.call(
            "NotifyPointerButton",
            (self.path()?, dict([]), code, u32::from(pressed)),
        )
        .await
    }
    pub async fn key_symbol(&self, symbol: u32, pressed: bool) -> Result<()> {
        self.require(1)?;
        self.wake_keyboard().await?;
        self.call(
            "NotifyKeyboardKeysym",
            (self.path()?, dict([]), symbol as i32, u32::from(pressed)),
        )
        .await
    }
    /// Wheel scrolling at a point of the stream when given, else where the pointer is.
    pub async fn scroll(&self, at: Option<(f64, f64)>, dx: f64, dy: f64) -> Result<()> {
        if !dx.is_finite() || !dy.is_finite() || dx.abs() > 1000. || dy.abs() > 1000. {
            return Err(crate::protocol::Fault::new(
                "bounds",
                "Scroll exceeds limit",
            ));
        }
        self.require(2)?;
        if let Some((x, y)) = at {
            self.motion(x, y).await?;
        } else {
            self.wake_pointer().await?;
        }
        // Wheel notches, as the person's wheel turns: one per 40 points, as on X11. Smooth
        // axis motion alone doesn't reach GTK's scroll handling in GNOME.
        let path = self.path()?;
        for (axis, delta) in [(0u32, dy), (1u32, dx)] {
            let steps = crate::x11_pointer::wheel_steps(delta) as i32;
            if steps > 0 {
                let signed = if delta > 0. { steps } else { -steps };
                self.call("NotifyPointerAxisDiscrete", (path, dict([]), axis, signed))
                    .await?;
            }
        }
        let finish: OwnedValue = true.into();
        self.call("NotifyPointerAxis", (path, dict([("finish", finish)]), 0f64, 0f64))
            .await
    }
}
