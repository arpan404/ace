//! Whether the person touched the keyboard or pointer within `RECENT_INPUT_MS`, from the
//! compositor's `ext-idle-notify-v1` (KWin, Hyprland; GNOME has its own IdleMonitor). One
//! notification with that timeout: `idled` after that long without input, `resumed` on the next
//! input. Its own connection and thread, so a busy act never delays the events.
use crate::computer::guard::RECENT_INPUT_MS;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};
use wayland_client::protocol::{wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::ext::idle_notify::v1::client::{ext_idle_notification_v1, ext_idle_notifier_v1};

const UNKNOWN: u8 = 0;
const IDLE: u8 = 1;
const ACTIVE: u8 = 2;

pub struct IdleWatch {
    state: Arc<AtomicU8>,
    started: Instant,
}

impl IdleWatch {
    /// Starts watching, or None when there is no Wayland display or the compositor offers no
    /// idle notifications.
    pub fn start() -> Option<Self> {
        let conn = Connection::connect_to_env().ok()?;
        let (globals, mut queue) = wayland_client::globals::registry_queue_init::<State>(&conn).ok()?;
        let handle = queue.handle();
        let seat: wl_seat::WlSeat = globals.bind(&handle, 1..=1, ()).ok()?;
        let notifier: ext_idle_notifier_v1::ExtIdleNotifierV1 = globals.bind(&handle, 1..=1, ()).ok()?;
        let state = Arc::new(AtomicU8::new(UNKNOWN));
        let mut dispatch = State { state: state.clone() };
        notifier.get_idle_notification(RECENT_INPUT_MS as u32, &seat, &handle, ());
        queue.roundtrip(&mut dispatch).ok()?;
        std::thread::Builder::new()
            .name("ace-idle-watch".into())
            .spawn(move || {
                let _keep = (seat, notifier);
                while queue.blocking_dispatch(&mut dispatch).is_ok() {}
            })
            .ok()?;
        Some(Self {
            state,
            started: Instant::now(),
        })
    }

    /// 0 while the person is active, None once they have been idle for the timeout. Before the
    /// first event: idle is announced after the timeout, so no announcement by then means input.
    pub fn ms_since_input(&self) -> Option<u64> {
        match self.state.load(Ordering::Acquire) {
            IDLE => None,
            ACTIVE => Some(0),
            _ if self.started.elapsed() > Duration::from_millis(RECENT_INPUT_MS + 250) => Some(0),
            _ => None,
        }
    }
}

struct State {
    state: Arc<AtomicU8>,
}

impl Dispatch<wl_registry::WlRegistry, wayland_client::globals::GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &wayland_client::globals::GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for State {
    fn event(_: &mut Self, _: &wl_seat::WlSeat, _: wl_seat::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<ext_idle_notifier_v1::ExtIdleNotifierV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &ext_idle_notifier_v1::ExtIdleNotifierV1,
        _: ext_idle_notifier_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ext_idle_notification_v1::ExtIdleNotificationV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &ext_idle_notification_v1::ExtIdleNotificationV1,
        event: ext_idle_notification_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let next = match event {
            ext_idle_notification_v1::Event::Idled => IDLE,
            ext_idle_notification_v1::Event::Resumed => ACTIVE,
            _ => return,
        };
        state.state.store(next, Ordering::Release);
    }
}
