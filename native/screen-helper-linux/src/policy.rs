use crate::protocol::{Fault, Result};

/// Live view needs a Wayland session: its portals are how the person shares a window and how
/// their input reaches it. X11 sessions are not supported.
pub fn wayland_session(wayland: Option<&str>, display: Option<&str>) -> Result<()> {
    let present = |v: Option<&str>| v.is_some_and(|s| !s.is_empty());
    if present(wayland) {
        return Ok(());
    }
    Err(Fault::new(
        "not_supported",
        if present(display) {
            "This is an X11 session. ace works on Wayland desktops only: log in to a Wayland session"
        } else {
            "No display session: WAYLAND_DISPLAY is not set; headless capture is unavailable"
        },
    ))
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

/// How a Wayland live view asks the portal for its source.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PortalRoute {
    /// One RemoteDesktop session with a ScreenCast source: the picture and the person's input.
    RemoteDesktop,
    /// ScreenCast alone: the person picks the source and watches it; no input goes through the
    /// portal, for the reason given.
    ScreenCastOnly(&'static str),
}

/// Why a live view on KDE takes no input. KDE's RemoteDesktop portal ignores the source a
/// session asks for and shares whole outputs, so the window the person picked would not be
/// what their clicks reach.
pub const KDE_WATCH_ONLY: &str = "KDE's remote control shares the whole desktop rather than the window or screen you pick, so on KDE ace shows what you share but can't send it your clicks or keys. Use the app on the desktop itself; agents act through element ids.";
/// Why a live view takes no input where the portal has no RemoteDesktop. ace never sends
/// input around the compositor's consent (ADR 0049).
pub const NO_REMOTE_DESKTOP: &str = "This desktop's screen-sharing portal has no remote control (RemoteDesktop; e.g. xdg-desktop-portal-hyprland or -wlr), so ace can show what you share here but can't send it your clicks or keys. Use the app on the desktop itself; agents act through element ids.";

/// GNOME's portal shares the picked window or screen together with input to it. KDE's would
/// share the whole desktop for a window (`KDE_WATCH_ONLY`), and Hyprland's portal (like other
/// portals without it) has no RemoteDesktop at all: both are asked of ScreenCast alone and are watch-only.
pub fn portal_route(desktop: &str, offer: &PortalOffer) -> PortalRoute {
    if desktop.split(':').any(|name| name.eq_ignore_ascii_case("KDE")) {
        PortalRoute::ScreenCastOnly(KDE_WATCH_ONLY)
    } else if offer.remote_desktop.is_none() {
        PortalRoute::ScreenCastOnly(NO_REMOTE_DESKTOP)
    } else {
        PortalRoute::RemoteDesktop
    }
}

/// What a live view can do on this desktop: the sources its dialog offers, the input the
/// person can be given, and whether the grant can be remembered.
pub fn portal_policy(offer: &PortalOffer, route: PortalRoute) -> PortalPolicy {
    let devices = match (route, offer.remote_desktop) {
        (PortalRoute::RemoteDesktop, Some(rd)) => rd.devices,
        _ => 0,
    };
    PortalPolicy {
        windows: offer.sources & 2 != 0,
        displays: offer.sources & 1 != 0,
        keyboard: devices & 1 != 0,
        pointer: devices & 2 != 0,
        // A combined session persists through RemoteDesktop (v2); a ScreenCast-only one through
        // ScreenCast's own persist_mode (v4).
        persistent: match (route, offer.remote_desktop) {
            (PortalRoute::RemoteDesktop, Some(rd)) => rd.version >= 2,
            _ => offer.screencast_version >= 4,
        },
    }
}

/// Whether the portal shared the kind of source that was asked for (`asked`: 1 monitor,
/// 2 window, 3 either), from the stream's `source_type` (1 monitor, 2 window, 4 virtual;
/// absent before ScreenCast version 3). A window never stands in for a screen, nor a screen
/// for a window (KDE's RemoteDesktop shares a monitor whatever is asked). A virtual source is
/// what was asked for: xdg-desktop-portal-hyprland 1.3 reports a shared window as one.
pub fn stream_matches(asked: u32, source_type: Option<u32>) -> bool {
    match (asked, source_type) {
        (2, Some(1)) | (1, Some(2)) => false,
        _ => true,
    }
}

/// A tree request cannot silently switch the approved capture scope.
pub fn scoped_target(requested: Option<&crate::protocol::Target>, active: Option<&crate::protocol::Target>) -> Result<()> {
    if requested.is_some() && requested != active {
        return Err(Fault::new("target_gone", "Tree target differs from active approved target"));
    }
    Ok(())
}
