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
pub fn portal_policy(sources: u32, devices: u32, version: u32) -> PortalPolicy {
    PortalPolicy {
        windows: sources & 2 != 0,
        displays: sources & 1 != 0,
        keyboard: devices & 1 != 0,
        pointer: devices & 2 != 0,
        persistent: version >= 2,
    }
}
