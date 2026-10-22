use crate::protocol::{Fault, Result};
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub enum Backend {
    X11,
    Wayland,
}
pub fn backend(
    selection: Option<&str>,
    wayland: Option<&str>,
    display: Option<&str>,
) -> Result<Backend> {
    let present = |v: Option<&str>| v.is_some_and(|s| !s.is_empty());
    match selection {
        Some("x11") if present(display) => Ok(Backend::X11),
        Some("wayland") if present(wayland) => Ok(Backend::Wayland),
        None if present(wayland) => Ok(Backend::Wayland),
        None if present(display) => Ok(Backend::X11),
        Some(v) if v != "x11" && v != "wayland" => {
            Err(Fault::new("not_supported", "Unknown display backend"))
        }
        _ => Err(Fault::new(
            "not_supported",
            "No display session: set DISPLAY or WAYLAND_DISPLAY; headless capture is unavailable",
        )),
    }
}
#[derive(Debug)]
pub struct DamageGate {
    dirty: bool,
    deadline: Duration,
    interval: Duration,
}
impl DamageGate {
    pub fn new(fps: u32) -> Self {
        Self {
            dirty: true,
            deadline: Duration::ZERO,
            interval: Duration::from_nanos(1_000_000_000 / u64::from(fps.clamp(1, 30))),
        }
    }
    pub fn damage(&mut self) {
        self.dirty = true;
    }
    pub fn wait(&self, now: Duration) -> Option<Duration> {
        self.dirty.then(|| self.deadline.saturating_sub(now))
    }
    pub fn take(&mut self, now: Duration) -> bool {
        if !self.dirty || now < self.deadline {
            return false;
        }
        self.dirty = false;
        self.deadline = now + self.interval;
        true
    }
}
pub fn point(x: f64, y: f64, width: u32, height: u32) -> Result<(f64, f64)> {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.
        || y < 0.
        || x >= f64::from(width)
        || y >= f64::from(height)
    {
        return Err(Fault::new("bounds", "Point is outside target"));
    }
    Ok((x, y))
}
#[derive(Debug, PartialEq)]
pub struct PortalPolicy {
    pub windows: bool,
    pub displays: bool,
    pub keyboard: bool,
    pub pointer: bool,
    pub persistent: bool,
}
/// What the desktop's xdg-desktop-portal offers. RemoteDesktop is optional: GNOME and KDE
/// implement it, xdg-desktop-portal-hyprland and xdg-desktop-portal-wlr do not.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PortalOffer {
    /// ScreenCast `AvailableSourceTypes` (1 monitor, 2 window, 4 virtual).
    pub sources: u32,
    pub screencast_version: u32,
    pub remote_desktop: Option<RemoteDesktopOffer>,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RemoteDesktopOffer {
    /// `AvailableDeviceTypes` (1 keyboard, 2 pointer, 4 touchscreen).
    pub devices: u32,
    pub version: u32,
}
pub fn portal_policy(offer: &PortalOffer) -> PortalPolicy {
    let devices = offer.remote_desktop.map_or(0, |rd| rd.devices);
    PortalPolicy {
        windows: offer.sources & 2 != 0,
        displays: offer.sources & 1 != 0,
        keyboard: devices & 1 != 0,
        pointer: devices & 2 != 0,
        // A combined session persists through RemoteDesktop (v2); a ScreenCast-only one through
        // ScreenCast's own persist_mode (v4).
        persistent: match offer.remote_desktop {
            Some(rd) => rd.version >= 2,
            None => offer.screencast_version >= 4,
        },
    }
}

/// A tree request cannot silently switch the approved capture scope.
pub fn scoped_target(requested: Option<&crate::protocol::Target>, active: Option<&crate::protocol::Target>) -> Result<()> {
    if requested.is_some() && requested != active {
        return Err(Fault::new("target_gone", "Tree target differs from active approved target"));
    }
    Ok(())
}
pub fn element_center(element: &crate::accessibility::Bounds, window: &crate::accessibility::Bounds) -> Result<(f64, f64)> {
    let x = f64::from(element.x) - f64::from(window.x) + f64::from(element.w) / 2.;
    let y = f64::from(element.y) - f64::from(window.y) + f64::from(element.h) / 2.;
    point(x, y, window.w.max(0) as u32, window.h.max(0) as u32)
}
