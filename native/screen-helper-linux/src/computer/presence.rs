//! The facts behind `guard.rs`, read from the desktop: whether the session is in front and
//! locked, and how long ago the person last gave input. Every call is bounded; a desktop that
//! answers nothing yields unknown facts, which never refuse an action.
use crate::computer::guard::{SessionFacts, SessionStatus, session_status};
use crate::computer::hyprland;
use crate::computer::wl_idle::IdleWatch;
use std::time::Duration;
use zbus::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

const TIMEOUT: Duration = Duration::from_millis(500);

/// Where the person's idle time comes from on this desktop.
enum IdleSource {
    Unprobed,
    /// GNOME: `org.gnome.Mutter.IdleMonitor`, in milliseconds.
    Mutter,
    /// KDE, Hyprland: the compositor's `ext-idle-notify-v1`.
    Wayland(IdleWatch),
    /// `org.freedesktop.ScreenSaver.GetSessionIdleTime`, in seconds.
    ScreenSaver,
    None,
}

pub struct Presence {
    session: Connection,
    system: Option<Connection>,
    idle: IdleSource,
}

impl Presence {
    pub async fn connect() -> Option<Self> {
        let session = tokio::time::timeout(Duration::from_secs(3), Connection::session()).await.ok()?.ok()?;
        let system = tokio::time::timeout(Duration::from_secs(3), Connection::system())
            .await
            .ok()
            .and_then(Result::ok);
        Some(Self {
            session,
            system,
            idle: IdleSource::Unprobed,
        })
    }

    pub fn session_bus(&self) -> &Connection {
        &self.session
    }

    pub async fn status(&self) -> SessionStatus {
        let (logind_active, logind_locked) = self.logind().await;
        let facts = SessionFacts {
            logind_active,
            logind_locked,
            screensaver_active: self.screensaver_active().await,
            locker_running: locker_running(),
            compositor_locked: tokio::task::spawn_blocking(hyprland::session_locked).await.ok().flatten(),
        };
        session_status(&facts)
    }

    /// Milliseconds since the person's last keyboard or pointer input, None where unknown.
    pub async fn ms_since_input(&mut self) -> Option<u64> {
        if matches!(self.idle, IdleSource::Unprobed) {
            self.idle = self.probe_idle().await;
        }
        match &self.idle {
            IdleSource::Mutter => self.mutter_idle().await,
            IdleSource::Wayland(watch) => watch.ms_since_input(),
            IdleSource::ScreenSaver => self.screensaver_idle().await,
            IdleSource::Unprobed | IdleSource::None => None,
        }
    }

    /// Where idle time comes from here, for `hello`: "mutter", "wayland", "screensaver" or "none".
    pub async fn idle_source(&mut self) -> &'static str {
        if matches!(self.idle, IdleSource::Unprobed) {
            self.idle = self.probe_idle().await;
        }
        match self.idle {
            IdleSource::Mutter => "mutter",
            IdleSource::Wayland(_) => "wayland",
            IdleSource::ScreenSaver => "screensaver",
            IdleSource::Unprobed | IdleSource::None => "none",
        }
    }

    /// Whether a desktop notification server is running, to show the "ace is using" notice.
    pub async fn notifications(&self) -> bool {
        Self::call::<String>(
            &self.session,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetNameOwner",
            &("org.freedesktop.Notifications",),
        )
        .await
        .is_some()
    }

    async fn probe_idle(&self) -> IdleSource {
        if self.mutter_idle().await.is_some() {
            return IdleSource::Mutter;
        }
        if let Ok(Some(watch)) = tokio::task::spawn_blocking(IdleWatch::start).await {
            return IdleSource::Wayland(watch);
        }
        if self.screensaver_idle().await.is_some() {
            return IdleSource::ScreenSaver;
        }
        IdleSource::None
    }

    async fn call<B: serde::de::DeserializeOwned + zbus::zvariant::Type>(
        conn: &Connection,
        dest: &str,
        path: &str,
        iface: &str,
        method: &str,
        body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
    ) -> Option<B> {
        let reply = tokio::time::timeout(TIMEOUT, conn.call_method(Some(dest), path, Some(iface), method, body))
            .await
            .ok()?
            .ok()?;
        reply.body().deserialize().ok()
    }

    async fn property(conn: &Connection, dest: &str, path: &str, iface: &str, name: &str) -> Option<OwnedValue> {
        Self::call(conn, dest, path, "org.freedesktop.DBus.Properties", "Get", &(iface, name)).await
    }

    async fn mutter_idle(&self) -> Option<u64> {
        Self::call(
            &self.session,
            "org.gnome.Mutter.IdleMonitor",
            "/org/gnome/Mutter/IdleMonitor/Core",
            "org.gnome.Mutter.IdleMonitor",
            "GetIdletime",
            &(),
        )
        .await
    }

    async fn screensaver_idle(&self) -> Option<u64> {
        let seconds: u32 = Self::call(
            &self.session,
            "org.freedesktop.ScreenSaver",
            "/org/freedesktop/ScreenSaver",
            "org.freedesktop.ScreenSaver",
            "GetSessionIdleTime",
            &(),
        )
        .await?;
        Some(u64::from(seconds) * 1000)
    }

    async fn screensaver_active(&self) -> Option<bool> {
        for (dest, path) in [
            ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"),
            ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver"),
        ] {
            let iface = dest;
            if let Some(active) = Self::call::<bool>(&self.session, dest, path, iface, "GetActive", &()).await {
                return Some(active);
            }
        }
        None
    }

    /// The user's graphical session from logind: (Active, LockedHint).
    async fn logind(&self) -> (Option<bool>, Option<bool>) {
        let Some(system) = &self.system else { return (None, None) };
        let uid = unsafe { libc::getuid() };
        let Some(user): Option<OwnedObjectPath> = Self::call(
            system,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
            "GetUser",
            &(uid,),
        )
        .await
        else {
            return (None, None);
        };
        let display = Self::property(system, "org.freedesktop.login1", user.as_str(), "org.freedesktop.login1.User", "Display").await;
        let Some((_, session)) = display.and_then(|value| <(String, OwnedObjectPath)>::try_from(value).ok()) else {
            return (None, None);
        };
        if session.as_str() == "/" {
            return (None, None);
        }
        let read = |name: &'static str| {
            let session = session.clone();
            async move {
                Self::property(system, "org.freedesktop.login1", session.as_str(), "org.freedesktop.login1.Session", name)
                    .await
                    .and_then(|value| bool::try_from(value).ok())
            }
        };
        (read("Active").await, read("LockedHint").await)
    }
}

/// Lock screens that are compositor clients rather than D-Bus services.
const LOCKERS: [&str; 4] = ["hyprlock", "swaylock", "gtklock", "waylock"];

fn locker_running() -> bool {
    let uid = unsafe { libc::getuid() };
    let Ok(entries) = std::fs::read_dir("/proc") else { return false };
    entries.flatten().any(|entry| {
        let path = entry.path();
        if !entry.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        let owned = std::os::unix::fs::MetadataExt::uid(&match std::fs::metadata(&path) {
            Ok(meta) => meta,
            Err(_) => return false,
        }) == uid;
        owned
            && std::fs::read_to_string(path.join("comm"))
                .is_ok_and(|comm| LOCKERS.contains(&comm.trim()))
    })
}
