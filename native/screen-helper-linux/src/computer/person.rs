//! The person's side of a request: the desktop kept awake while the agent works, the "ace is
//! using <app>" notice with its Stop, and the guard before each step (`guard.rs`).
use crate::computer::awake::{Awake, LEASE};
use crate::computer::bus::{Bus, Obj};
use crate::computer::cancel::StopSignal;
use crate::computer::element;
use crate::computer::error::CuResult;
use crate::computer::guard::{self, GuardFacts, SessionStatus, TargetFacts};
use crate::computer::notice::Notice;
use crate::computer::presence::Presence;
use crate::computer::session::AppSession;
use serde_json::{Map, Value};
use std::time::Duration;

pub struct Person {
    presence: Option<Presence>,
    awake: Option<Awake>,
    notice: Option<Notice>,
    stop: StopSignal,
}

impl Person {
    /// `lease` overrides the keep-awake lease (tests); the default is the macOS engine's.
    pub async fn connect(stop: StopSignal, lease: Option<Duration>) -> Self {
        let presence = Presence::connect().await;
        let notice = match &presence {
            Some(presence) => Some(Notice::start(presence.session_bus().clone(), stop.clone()).await),
            None => None,
        };
        let awake = presence
            .as_ref()
            .map(|presence| {
                Awake::new(presence.session_bus().clone(), lease.unwrap_or(LEASE), notice.clone(), stop.clone())
            });
        Self {
            presence,
            awake,
            notice,
            stop,
        }
    }

    pub async fn status(&self) -> SessionStatus {
        match &self.presence {
            Some(presence) => presence.status().await,
            None => SessionStatus::Active,
        }
    }

    /// Before a look (`acting` false) or a batch of actions in `app`.
    pub async fn begin(&self, app: &str, acting: bool) {
        if let Some(awake) = &self.awake {
            awake.hold().await;
        }
        if acting {
            self.stop.set_acting(true);
            if let Some(notice) = &self.notice {
                notice.show(app).await;
            }
        }
    }

    /// After the request. A batch that may continue keeps the lease; a failure, a cancel or the
    /// person's Stop ends it, and Stop is used up.
    pub async fn end(&self, outcome: Outcome) {
        self.stop.set_acting(false);
        let Some(awake) = &self.awake else { return };
        match outcome {
            Outcome::Continues => awake.linger().await,
            Outcome::Ended => awake.release().await,
            Outcome::Stopped => {
                self.stop.take();
                awake.release().await;
            }
        }
    }

    /// Whether `step` may run in `session` now. Reads the person's focus only when they may be
    /// using the app.
    pub async fn check_step(&mut self, bus: &Bus, session: &mut AppSession, step: &Map<String, Value>) -> CuResult<()> {
        let stop_requested = self.stop.pressed();
        let status = self.status().await;
        let windows = if stop_requested || status != SessionStatus::Active {
            Vec::new()
        } else {
            session.windows(bus).await
        };
        let active = windows.iter().find(|w| w.active).map(|w| w.obj.clone());
        let ms_since_input = match (&mut self.presence, &active) {
            (Some(presence), Some(_)) => presence.ms_since_input().await,
            _ => None,
        };
        let facts = GuardFacts {
            stop_requested,
            status,
            app_active: active.is_some(),
            ms_since_input,
        };
        let conflict = if facts.person_may_be_using() {
            conflicts(bus, session, step, active.as_ref()).await
        } else {
            false
        };
        guard::guard(&facts, &session.name, || conflict)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Continues,
    Ended,
    Stopped,
}

/// The person's focus, read fresh, against the step's element.
async fn conflicts(bus: &Bus, session: &mut AppSession, step: &Map<String, Value>, active: Option<&Obj>) -> bool {
    let same_window = session.window.as_ref().map(|w| &w.obj) == active;
    if !same_window {
        return false;
    }
    session.walk(bus, None, Duration::from_secs(2)).await;
    let focused = session.focused.as_ref().and_then(|f| f.obj.clone());
    let target = match step.get("id").and_then(Value::as_u64) {
        Some(id) => session.ids.get(id).cloned(),
        None => None,
    };
    let contains_focus = match (&target, &focused) {
        (Some(target), Some(focused)) => is_or_contains(bus, target, focused).await,
        _ => false,
    };
    guard::conflicts_with_person(&TargetFacts {
        observing: false,
        explicit_target: target.is_some(),
        same_window,
        focus_known: focused.is_some(),
        contains_focus,
    })
}

async fn is_or_contains(bus: &Bus, target: &Obj, focused: &Obj) -> bool {
    let mut current = focused.clone();
    for _ in 0..24 {
        if &current == target {
            return true;
        }
        match element::parent(bus, &current).await {
            Some(parent) => current = parent,
            None => return false,
        }
    }
    false
}
