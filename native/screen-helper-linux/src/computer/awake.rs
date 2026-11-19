//! Keeps the desktop awake for computer use, as the macOS engine does (`ComputerPower.swift`):
//! during a batch the screen stays on and the session never goes idle; between calls, for a
//! five-minute lease the next call renews, only automatic suspend is held off, so the screen
//! may blank and lock. Neither stops the person from locking, suspending or logging out.
//! Inhibitors belong to this helper's bus connection, so they end with the helper.
use crate::computer::cancel::StopSignal;
use crate::computer::notice::Notice;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use zbus::Connection;

pub const LEASE: Duration = Duration::from_secs(300);
const TIMEOUT: Duration = Duration::from_millis(500);

/// One held inhibitor and how to give it back.
#[derive(Clone, Copy)]
enum Held {
    /// `org.freedesktop.ScreenSaver.Inhibit` (GNOME through gsd-screensaver-proxy, KDE, hypridle).
    ScreenSaver(u32),
    /// `org.gnome.SessionManager.Inhibit` with the suspend flag.
    GnomeSession(u32),
    /// `org.freedesktop.PowerManagement.Inhibit` (KDE PowerDevil).
    PowerManagement(u32),
}

#[derive(Default)]
struct State {
    batch: Option<Held>,
    lease: Option<Held>,
    revision: u64,
}

#[derive(Clone)]
pub struct Awake {
    conn: Connection,
    state: Arc<Mutex<State>>,
    lease: Duration,
    /// Withdrawn with the lease: the agent is no longer using the app.
    notice: Option<Notice>,
    /// A Stop nobody acted on ends with the lease, so it never stops a later, unrelated request.
    stop: StopSignal,
}

impl Awake {
    pub fn new(conn: Connection, lease: Duration, notice: Option<Notice>, stop: StopSignal) -> Self {
        Self {
            conn,
            state: Arc::new(Mutex::new(State::default())),
            lease,
            notice,
            stop,
        }
    }

    /// At the start of a look or a batch: the screen stays on until `linger` or `release`.
    pub async fn hold(&self) {
        let mut state = self.state.lock().await;
        state.revision += 1;
        if state.lease.is_none() {
            state.lease = self.suspend_inhibit().await;
        }
        if state.batch.is_none() {
            state.batch = self.idle_inhibit().await;
        }
    }

    /// After a batch that may continue: the screen may sleep again, and suspend stays held
    /// off until the lease ends unless another call renews it.
    pub async fn linger(&self) {
        let revision = {
            let mut state = self.state.lock().await;
            if let Some(held) = state.batch.take() {
                self.give_back(held).await;
            }
            state.revision += 1;
            state.revision
        };
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(this.lease).await;
            let mut state = this.state.lock().await;
            if state.revision == revision {
                if let Some(held) = state.lease.take() {
                    this.give_back(held).await;
                }
                if let Some(notice) = &this.notice {
                    notice.withdraw().await;
                }
                this.stop.take();
            }
        });
    }

    /// After a failed or cancelled batch, and at shutdown.
    pub async fn release(&self) {
        let mut state = self.state.lock().await;
        state.revision += 1;
        for held in [state.batch.take(), state.lease.take()].into_iter().flatten() {
            self.give_back(held).await;
        }
        if let Some(notice) = &self.notice {
            notice.withdraw().await;
        }
    }

    async fn call<B: serde::de::DeserializeOwned + zbus::zvariant::Type>(
        &self,
        dest: &str,
        path: &str,
        iface: &str,
        method: &str,
        body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
    ) -> Option<B> {
        let reply = tokio::time::timeout(TIMEOUT, self.conn.call_method(Some(dest), path, Some(iface), method, body))
            .await
            .ok()?
            .ok()?;
        reply.body().deserialize().ok()
    }

    async fn idle_inhibit(&self) -> Option<Held> {
        let reason = "An agent is using an app on this computer";
        let cookie = self
            .call(
                "org.freedesktop.ScreenSaver",
                "/org/freedesktop/ScreenSaver",
                "org.freedesktop.ScreenSaver",
                "Inhibit",
                &("ace", reason),
            )
            .await?;
        Some(Held::ScreenSaver(cookie))
    }

    async fn suspend_inhibit(&self) -> Option<Held> {
        let reason = "An agent is working with apps on this computer";
        // Flag 4: automatic suspend only.
        if let Some(cookie) = self
            .call(
                "org.gnome.SessionManager",
                "/org/gnome/SessionManager",
                "org.gnome.SessionManager",
                "Inhibit",
                &("ace", 0u32, reason, 4u32),
            )
            .await
        {
            return Some(Held::GnomeSession(cookie));
        }
        let cookie = self
            .call(
                "org.freedesktop.PowerManagement",
                "/org/freedesktop/PowerManagement/Inhibit",
                "org.freedesktop.PowerManagement.Inhibit",
                "Inhibit",
                &("ace", reason),
            )
            .await?;
        Some(Held::PowerManagement(cookie))
    }

    async fn give_back(&self, held: Held) {
        let _: Option<()> = match held {
            Held::ScreenSaver(cookie) => {
                self.call(
                    "org.freedesktop.ScreenSaver",
                    "/org/freedesktop/ScreenSaver",
                    "org.freedesktop.ScreenSaver",
                    "UnInhibit",
                    &(cookie,),
                )
                .await
            }
            Held::GnomeSession(cookie) => {
                self.call(
                    "org.gnome.SessionManager",
                    "/org/gnome/SessionManager",
                    "org.gnome.SessionManager",
                    "Uninhibit",
                    &(cookie,),
                )
                .await
            }
            Held::PowerManagement(cookie) => {
                self.call(
                    "org.freedesktop.PowerManagement",
                    "/org/freedesktop/PowerManagement/Inhibit",
                    "org.freedesktop.PowerManagement.Inhibit",
                    "UnInhibit",
                    &(cookie,),
                )
                .await
            }
        };
    }
}
