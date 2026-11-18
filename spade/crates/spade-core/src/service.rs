//! A bot's owned services (ADR 0160): long-lived processes it started with `service_start`, as
//! its `service_started` and `service_ended` events tell. Pure.

use serde::{Deserialize, Serialize};

use crate::event::{Event, Known};

pub const SERVICE_START: &str = "service_start";
pub const SERVICE_STATUS: &str = "service_status";
pub const SERVICE_LOGS: &str = "service_logs";
pub const SERVICE_STOP: &str = "service_stop";

/// How a service ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ended {
    /// It exited by itself.
    Exited,
    /// The bot, the person or Stop stopped it.
    Stopped,
    /// Spade restarted and it was not marked `keep`.
    Lost,
    /// It could not be started.
    Failed,
    #[serde(other)]
    Other,
}

impl Ended {
    pub fn name(self) -> &'static str {
        match self {
            Self::Exited => "exited",
            Self::Stopped => "stopped",
            Self::Lost => "lost",
            Self::Failed => "failed",
            Self::Other => "ended",
        }
    }
}

/// A service as its events tell it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Service {
    pub service: String,
    pub name: String,
    pub command: String,
    /// Relative to the workspace; empty for the workspace itself.
    pub cwd: String,
    pub keep: bool,
    /// How many times Spade started it again after a restart.
    pub restarts: u32,
    /// The gate let it start only held by the sandbox.
    pub contained_only: bool,
    /// `None` while it runs.
    pub ended: Option<(Ended, Option<i32>)>,
}

impl Service {
    pub fn running(&self) -> bool {
        self.ended.is_none()
    }

    pub fn state(&self) -> &'static str {
        self.ended.map_or("running", |(how, _)| how.name())
    }
}

/// Every service the bot started, oldest first; a name started again replaces its older entry.
pub fn services<'a>(events: impl IntoIterator<Item = &'a Event>) -> Vec<Service> {
    let mut out: Vec<Service> = Vec::new();
    for event in events {
        let Event::Known(known) = event else { continue };
        match known {
            Known::ServiceStarted {
                service,
                name,
                command,
                cwd,
                keep,
                restarts,
                contained_only,
            } => {
                out.retain(|s| s.name != *name && s.service != *service);
                out.push(Service {
                    service: service.clone(),
                    name: name.clone(),
                    command: command.clone(),
                    cwd: cwd.clone(),
                    keep: *keep,
                    restarts: *restarts,
                    contained_only: *contained_only,
                    ended: None,
                });
            }
            Known::ServiceEnded {
                service,
                cause,
                code,
            } => {
                if let Some(s) = out.iter_mut().find(|s| &s.service == service) {
                    s.ended = Some((*cause, *code));
                }
            }
            _ => {}
        }
    }
    out
}

/// The running services.
pub fn running<'a>(events: impl IntoIterator<Item = &'a Event>) -> Vec<Service> {
    services(events)
        .into_iter()
        .filter(Service::running)
        .collect()
}

/// The service named `name` (or with that id), running or not.
pub fn named<'a>(events: impl IntoIterator<Item = &'a Event>, name: &str) -> Option<Service> {
    services(events)
        .into_iter()
        .rev()
        .find(|s| s.name == name || s.service == name)
}

/// Whether `name` is a service name a bot may use: 1 to 40 of letters, digits, `-`, `_`, `.`.
pub fn valid_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started(service: &str, name: &str, keep: bool) -> Event {
        Event::Known(Known::ServiceStarted {
            service: service.into(),
            name: name.into(),
            command: "npm run dev".into(),
            cwd: String::new(),
            keep,
            restarts: 0,
            contained_only: false,
        })
    }

    #[test]
    fn a_service_runs_until_its_end_is_stored_and_a_restarted_name_replaces_the_old_entry() {
        let mut events = vec![started("s1", "web", true)];
        assert_eq!(running(&events).len(), 1);
        events.push(Event::Known(Known::ServiceEnded {
            service: "s1".into(),
            cause: Ended::Exited,
            code: Some(1),
        }));
        assert!(running(&events).is_empty());
        assert_eq!(named(&events, "web").map(|s| s.state()), Some("exited"));
        events.push(started("s2", "web", false));
        let all = services(&events);
        assert_eq!(all.len(), 1, "one entry per name");
        assert_eq!(all[0].service, "s2");
        assert!(all[0].running());
    }

    #[test]
    fn an_end_from_a_newer_spade_still_ends_the_service() {
        let events = vec![
            started("s1", "web", false),
            Event::from_json(serde_json::json!({
                "type": "service_ended", "service": "s1", "cause": "evaporated"
            })),
        ];
        assert_eq!(named(&events, "s1").map(|s| s.state()), Some("ended"));
    }

    #[test]
    fn service_names_are_short_and_plain() {
        assert!(valid_name("dev-server_2.web"));
        assert!(!valid_name(""));
        assert!(!valid_name("a b"));
        assert!(!valid_name("../x"));
        assert!(!valid_name(&"x".repeat(41)));
    }
}
