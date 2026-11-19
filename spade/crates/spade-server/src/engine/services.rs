//! A bot's owned services (ADR 0160) as the engine records them: `service_started` before the
//! process starts, `service_ended` when it exits, is stopped, or is lost to a restart. The
//! processes are `crate::services`; which services exist is the fold `spade_core::service`.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use spade_core::Event;
use spade_core::event::Known;
use spade_core::service::{self, Ended, Service};
use spade_store::StoreError;

use super::Engine;
use crate::services::{Launch, Line, Services};
use crate::workspace::outside::{Bound, Warrant};
use crate::workspace::shell::Launch as Decided;
use spade_core::event::Authorized;

impl Engine {
    /// Where bots' services run. Set once, by the server; `keep` services start again once Spade
    /// is open for work.
    pub fn set_services(self: &Arc<Self>, services: Arc<Services>) {
        let _ = self.services.set(services);
        if self.wakes.restored_once() {
            self.restore_services();
        }
    }

    pub(crate) fn services(&self) -> Option<&Arc<Services>> {
        self.services.get()
    }

    /// How many of `conversation`'s services run now.
    pub(crate) fn services_running(&self, conversation: &str) -> usize {
        self.services()
            .map_or(0, |services| services.running_of(conversation))
    }

    /// Starts service `name` running `command` in `cwd` for tool call `key`
    /// (`conversation.call`); its id. Refused once the person stopped the reply or job that made
    /// the call: admitted and stored under the record lock Stop stores its marker under, so a
    /// service started before the marker is there for Stop to end, and none starts after it.
    pub(crate) fn service_start(
        self: &Arc<Self>,
        key: &str,
        name: &str,
        command: &str,
        cwd: &str,
        keep: bool,
    ) -> Result<String, String> {
        let (id, call) = super::wakes::split_key(key);
        let services = self.services().ok_or("Services are not available here.")?;
        let bot = self
            .agent_of(id)
            .ok_or("Only a bot has services: this conversation has none.")?;
        if !service::valid_name(name) {
            return Err("A service name is 1 to 40 of letters, digits, - _ and .".to_owned());
        }
        services.folder(&bot, cwd)?;
        // What the gate authorized for this call, carried to the launch (ADR 0171).
        let (decided, warrant) = self.take_launch(key);
        self.registering("service", id);
        let id_of = self.ids.next("s");
        {
            let _order = super::wakes::lock(&self.record_lock);
            let events = self.load(id).map_err(|e| e.to_string())?;
            let stopped = match call {
                Some(call) => spade_core::turn::call_stopped(&events, call),
                None => false,
            };
            if stopped {
                return Err(super::wakes::STOPPED.to_owned());
            }
            if service::running(events.iter())
                .iter()
                .any(|s| s.name == name)
            {
                return Err(format!(
                    "{name} is already running; stop it with service_stop first, or pick another \
                     name."
                ));
            }
            let started = Event::Known(Known::ServiceStarted {
                service: id_of.clone(),
                name: name.to_owned(),
                command: command.to_owned(),
                cwd: cwd.to_owned(),
                keep,
                restarts: 0,
                contained_only: decided == Decided::Contained,
                // Kept, so a start again after a restart is held to the same verdict.
                launch: warrant.as_ref().map(|w| w.limit),
                bound: warrant.as_ref().and_then(|w| w.bound.stored()),
            });
            self.append(id, &started).map_err(|e| e.to_string())?;
        }
        self.launch(id, &bot, &id_of, name, command, cwd, decided, warrant)?;
        // Stop came between the write and the launch, and may have ended the service before its
        // process ran: the process stops too.
        let stopped = call.is_some_and(|call| {
            self.load(id)
                .is_ok_and(|events| spade_core::turn::call_stopped(&events, call))
        });
        if stopped {
            services.stop(&id_of);
            if let Err(error) = self.service_stop(id, &id_of) {
                tracing::warn!(%error, "could not store that a stopped service ended");
            }
            return Err(super::wakes::STOPPED.to_owned());
        }
        self.announce(id);
        Ok(id_of)
    }

    #[allow(clippy::too_many_arguments)]
    fn launch(
        self: &Arc<Self>,
        id: &str,
        bot: &str,
        service: &str,
        name: &str,
        command: &str,
        cwd: &str,
        decided: Decided,
        warrant: Option<Warrant>,
    ) -> Result<(), String> {
        let Some(services) = self.services() else {
            return Err("Services are not available here.".to_owned());
        };
        let launched = services.start(Launch {
            conversation: id.to_owned(),
            bot: bot.to_owned(),
            service: service.to_owned(),
            name: name.to_owned(),
            command: command.to_owned(),
            cwd: cwd.to_owned(),
            decided,
            warrant,
        });
        if let Err(why) = &launched {
            self.service_ended(id, service, Ended::Failed, None, why);
        }
        launched
    }

    /// A service ended by itself (Services calls this).
    pub(crate) fn service_exited(
        self: &Arc<Self>,
        id: &str,
        service: &str,
        code: Option<i32>,
        failed: Option<String>,
    ) {
        let how = match (&failed, code) {
            (Some(why), _) => format!("could not run: {why}"),
            (None, Some(code)) => format!("exited with code {code}"),
            (None, None) => "was ended by a signal".to_owned(),
        };
        let cause = if failed.is_some() {
            Ended::Failed
        } else {
            Ended::Exited
        };
        self.service_ended(id, service, cause, code, &how);
    }

    /// Records that `service` ended and fires the waits on it.
    fn service_ended(
        self: &Arc<Self>,
        id: &str,
        service: &str,
        cause: Ended,
        code: Option<i32>,
        how: &str,
    ) {
        let ended = Event::Known(Known::ServiceEnded {
            service: service.to_owned(),
            cause,
            code,
        });
        let name = self
            .load(id)
            .ok()
            .and_then(|events| service::named(events.iter(), service))
            .map(|s| s.name);
        if let Err(error) = self.record(id, &ended) {
            tracing::error!(%error, "could not store that a service ended");
        }
        if let Some(name) = name {
            self.wake_on_service_end(id, service, &name, how);
        }
        self.announce(id);
    }

    /// Stops service `name` (or id) of conversation `id`; whether it was running.
    pub(crate) fn service_stop(self: &Arc<Self>, id: &str, name: &str) -> Result<bool, StoreError> {
        let events = self.load(id)?;
        let Some(found) = service::running(events.iter())
            .into_iter()
            .find(|s| s.name == name || s.service == name)
        else {
            return Ok(false);
        };
        if let Some(services) = self.services() {
            services.stop(&found.service);
        }
        self.service_ended(id, &found.service, Ended::Stopped, None, "was stopped");
        Ok(true)
    }

    /// Stop or delete: every running service of the conversation stops. Whether any ran.
    pub(super) fn stop_services(self: &Arc<Self>, id: &str) -> bool {
        let running = self
            .load(id)
            .map(|events| service::running(events.iter()))
            .unwrap_or_default();
        for found in &running {
            if let Some(services) = self.services() {
                services.stop(&found.service);
            }
            self.service_ended(id, &found.service, Ended::Stopped, None, "was stopped");
        }
        !running.is_empty()
    }

    /// The services of agent `agent` (by id), newest last; `None` for no such agent.
    pub fn agent_services(&self, agent: &str) -> Result<Option<Vec<Service>>, StoreError> {
        let Some(agent) = self.store.agent(agent)? else {
            return Ok(None);
        };
        Ok(Some(service::services(
            self.load(&agent.conversation)?.iter(),
        )))
    }

    /// Lines of agent `agent`'s service `name` after line `after`, at most `most`, and the next
    /// line's number. `None` when there is no such service, or no output kept for it.
    pub fn service_lines(
        &self,
        agent: &str,
        name: &str,
        after: u64,
        most: usize,
    ) -> Result<Option<(Vec<Line>, u64)>, StoreError> {
        let Some(found) = self.agent_services(agent)?.and_then(|all| {
            all.into_iter()
                .rev()
                .find(|s| s.name == name || s.service == name)
        }) else {
            return Ok(None);
        };
        Ok(self
            .services()
            .and_then(|services| services.lines(&found.service, after, most)))
    }

    /// The person stops agent `agent`'s service; `None` for no such agent.
    pub fn stop_agent_service(
        self: &Arc<Self>,
        agent: &str,
        name: &str,
    ) -> Result<Option<bool>, StoreError> {
        let Some(agent) = self.store.agent(agent)? else {
            return Ok(None);
        };
        self.service_stop(&agent.conversation, name).map(Some)
    }

    /// After a restart: a service the events show running whose process is gone starts again if
    /// it was marked `keep`, else is recorded lost. Once, when both the services and work are open.
    pub(super) fn restore_services(self: &Arc<Self>) {
        let Some(services) = self.services().cloned() else {
            return;
        };
        if self.wakes.services_restored.swap(true, Ordering::SeqCst) {
            return;
        }
        let Ok(conversations) = self.store.conversations() else {
            return;
        };
        for conversation in conversations {
            let id = conversation.id;
            let running = self
                .load(&id)
                .map(|events| service::running(events.iter()))
                .unwrap_or_default();
            for found in running {
                if services.is_running(&found.service) {
                    continue;
                }
                let bot = self.agent_of(&id);
                match (found.keep, bot) {
                    (true, Some(bot)) => {
                        let again = Event::Known(Known::ServiceStarted {
                            service: found.service.clone(),
                            name: found.name.clone(),
                            command: found.command.clone(),
                            cwd: found.cwd.clone(),
                            keep: true,
                            restarts: found.restarts.saturating_add(1),
                            contained_only: found.contained_only,
                            launch: found.launch,
                            bound: found.bound.clone(),
                        });
                        if self.record(&id, &again).is_ok() {
                            let _ = self.launch(
                                &id,
                                &bot,
                                &found.service,
                                &found.name,
                                &found.command,
                                &found.cwd,
                                // No gate decides a restart: it is held to the verdict that
                                // started it. One it let start only held starts only held again,
                                // or not at all; so does one an older build recorded no launch
                                // for. Elsewhere its start passes that verdict's warrant, read
                                // against its folder as it is now.
                                match found.launch {
                                    Some(limit)
                                        if limit != Authorized::Contained
                                            && !found.contained_only =>
                                    {
                                        Decided::Reviewed
                                    }
                                    _ => Decided::Contained,
                                },
                                found.launch.map(|limit| Warrant {
                                    limit,
                                    bound: Bound::from_stored(found.bound.clone()),
                                }),
                            );
                        }
                    }
                    _ => self.service_ended(
                        &id,
                        &found.service,
                        Ended::Lost,
                        None,
                        "was lost when Spade restarted",
                    ),
                }
            }
        }
    }
}
