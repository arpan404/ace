//! Waiting for an app to settle after an action: WinEvents from the app's processes say it is
//! still changing; quiet after its last event (or a short interval when it sends none) means
//! it is done. The events arrive as messages, so waiting pumps this thread's queue.
use super::cancel::Checkpoint;
use super::error::CuResult;
use super::timing::{settled, SettleRule};
use std::cell::Cell;
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::HWND,
    UI::{Accessibility::*, WindowsAndMessaging::*},
};

thread_local! {
    static LAST_EVENT: Cell<Option<Instant>> = const { Cell::new(None) };
}

const OBJID_CARET: i32 = -8;
const OBJID_CURSOR: i32 = -9;

unsafe extern "system" fn on_event(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    // The caret blinks and the cursor moves without the app changing.
    if object == OBJID_CARET || object == OBJID_CURSOR {
        return;
    }
    LAST_EVENT.with(|last| last.set(Some(Instant::now())));
}

pub struct Activity {
    hooks: Vec<HWINEVENTHOOK>,
    started: Instant,
}

impl Activity {
    /// Listens to the app's processes until dropped.
    pub fn watch(pids: &[u32]) -> Self {
        let hooks = pids
            .iter()
            .take(8)
            .map(|pid| unsafe {
                SetWinEventHook(
                    EVENT_MIN,
                    EVENT_MAX,
                    None,
                    Some(on_event),
                    *pid,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            })
            .filter(|hook| !hook.is_invalid())
            .collect();
        Self {
            hooks,
            started: Instant::now(),
        }
    }

    /// An action starts now: events before it no longer count.
    pub fn begin(&mut self) {
        pump();
        LAST_EVENT.with(|last| last.set(None));
        self.started = Instant::now();
    }

    /// Waits until the app has settled after the action that began last.
    pub fn settle(&mut self, rule: &SettleRule, check: &Checkpoint) -> CuResult<()> {
        loop {
            pump();
            let now = Instant::now();
            let since_event = LAST_EVENT.with(Cell::get).map(|at| now - at);
            if self.hooks.is_empty() || settled(rule, now - self.started, since_event) {
                if self.hooks.is_empty() {
                    std::thread::sleep(rule.unreacted.saturating_sub(now - self.started));
                }
                return Ok(());
            }
            check.check()?;
            unsafe {
                MsgWaitForMultipleObjects(None, false, 10, QS_ALLINPUT);
            }
        }
    }

    /// Sleeps while pumping, checking for cancellation every 50 ms.
    pub fn pause(&mut self, total: Duration, check: &Checkpoint) -> CuResult<()> {
        let end = Instant::now() + total;
        loop {
            pump();
            check.check()?;
            let now = Instant::now();
            if now >= end {
                return Ok(());
            }
            let wait = (end - now).min(Duration::from_millis(50));
            unsafe {
                MsgWaitForMultipleObjects(None, false, wait.as_millis() as u32, QS_ALLINPUT);
            }
        }
    }
}

impl Drop for Activity {
    fn drop(&mut self) {
        for hook in self.hooks.drain(..) {
            unsafe {
                let _ = UnhookWinEvent(hook);
            }
        }
        pump();
    }
}

/// Delivers queued messages (WinEvent callbacks among them) on this thread.
pub fn pump() {
    unsafe {
        let mut message = MSG::default();
        while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}
