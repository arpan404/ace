//! Running one call of a package's code (ADR 0203 §2, §4, §5). The code tool itself was gated as
//! any tool, its effect read from its imports. Here it runs on the bot's worker, and every
//! request the component makes is decided by Spade:
//!
//! - `tools`: one of Spade's own `spade.v1` tools, gated by the same rules as the model's calls
//!   (`effect::route`), the package's ceiling first and in every mode. What the gate would put to
//!   the reviewer or the person is put to the person, in the bot's conversation, while the call
//!   waits (waiting doesn't count against its deadline). Nothing the person answered before
//!   carries over to code, so a send from code is the person's each time.
//! - `http`: only to an https host the package declares under `network` with its switch on, and
//!   only while the ceiling allows `network`, carried through the bot's egress proxy.
//! - `kv` isn't in this build: answered with why.
//!
//! The call's output is untrusted when its input was, when it made any `http` request, or when a
//! tool it called answered untrusted content. Its time, fuel, peak memory, the hosts it reached
//! and the tools it called are stored beside it (`code_ran`). Stop ends it: the worker is told at
//! once, and the call is recorded as stopped, never done.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use spade_core::autonomy;
use spade_core::effect::{self, Route};
use spade_core::event::{Authorized, Known};
use spade_core::package::code::Code as Entry;
use spade_core::package::code::run::{self as code_run, Stop};
use spade_core::{Event, Transcript};
use spade_wasm::{
    Answer, Cut, Event as CodeEvent, HostRequest, HostValue, Outcome, Running, Target,
};

use super::Engine;
use crate::code::http::Request;
use crate::tools::{ToolOutput, TurnFacts};

/// One code tool call, as the tool hands it to the engine.
pub struct CodeCall {
    /// `<conversation>.<call id>`.
    pub key: String,
    pub entry: Entry,
    pub sha: String,
    pub tool: String,
    pub input: Value,
    /// The prompt the call was made from showed untrusted content.
    pub untrusted_input: bool,
    pub facts: TurnFacts,
}

/// What a running call has done so far.
#[derive(Default)]
struct Tally {
    tainted: bool,
    reached: Vec<String>,
    /// Bounded, whatever the component asks for.
    calls: code_run::CallLog,
    asked: u32,
}

/// The most hosts a call's `code_ran` names.
const MOST_REACHED: usize = 32;

/// Where the call runs.
struct At<'a> {
    conversation: &'a str,
    call_id: &'a str,
    reply: &'a str,
    bot: &'a str,
    entry: &'a Entry,
    facts: &'a TurnFacts,
}

/// How long a call waiting on the person looks again for their answer, besides being woken.
const ANSWER_POLL: Duration = Duration::from_millis(250);
const DECLINED: &str = "The person declined it.";

impl Engine {
    pub fn set_code(self: &Arc<Self>, code: Arc<crate::code::Code>) {
        code.bind(Arc::downgrade(self));
        let _ = self.code.set(code);
    }

    pub fn code(&self) -> Option<Arc<crate::code::Code>> {
        self.code.get().cloned()
    }

    /// Runs `call` to its end and answers the bot with what it came to.
    pub(crate) async fn run_code(self: Arc<Self>, call: CodeCall) -> ToolOutput {
        let (conversation, call_id) = call.key.split_once('.').unwrap_or((&call.key, ""));
        let (Some(code), Some(bot)) = (self.code(), self.agent_of(conversation)) else {
            return ToolOutput::error("This Spade runs no package code.");
        };
        let Some(link) = self.bot_package(&bot) else {
            return ToolOutput::error("This bot has no package code.");
        };
        // The pin and the switch as they are now: an update or a switch since the call was
        // decided is the one that counts.
        if link.code.get(&call.entry.name) != Some(&call.sha)
            || !link.on.contains(&code_run::switch_key(&call.entry.name))
        {
            return ToolOutput::error(format!(
                "Not run: {} changed or was turned off since. Carry on without it.",
                call.entry.name
            ));
        }
        let reply = self
            .load(conversation)
            .ok()
            .and_then(|events| {
                Transcript::fold(events.iter())
                    .open_reply()
                    .and_then(|m| m.reply.clone())
            })
            .unwrap_or_default();
        let worker = match code.bot(&bot).await {
            Ok(worker) => worker,
            Err(why) => {
                return ToolOutput::error(format!("{} couldn't start: {why}", call.entry.name));
            }
        };
        let target = Target::Tool {
            name: call.tool.clone(),
        };
        let running = match worker
            .call(
                &call.sha,
                target,
                &call.input.to_string(),
                call.entry.bounds(),
            )
            .await
        {
            Ok(running) => running,
            Err(why) => {
                return ToolOutput::error(format!("{} couldn't start: {why}", call.entry.name));
            }
        };
        let mut open = Open {
            running: Some(running),
            engine: self.clone(),
            conversation: conversation.to_owned(),
            reply: reply.clone(),
            call_id: call_id.to_owned(),
            component: call.entry.name.clone(),
        };
        let at = At {
            conversation,
            call_id,
            reply: &reply,
            bot: &bot,
            entry: &call.entry,
            facts: &call.facts,
        };
        let mut tally = Tally {
            tainted: call.untrusted_input,
            ..Tally::default()
        };
        let outcome = loop {
            let Some(running) = open.running.as_mut() else {
                break Outcome::Failed {
                    cut: Cut::Lost,
                    message: String::new(),
                    stats: spade_wasm::Stats::default(),
                    logs: Vec::new(),
                };
            };
            match running.next().await {
                CodeEvent::Host { request, call } => {
                    let answer = self.code_host(&at, &link, call, &mut tally).await;
                    if let Some(running) = open.running.as_ref() {
                        // A worker that's gone ends the call through `next`.
                        let _ = running.reply(request, answer).await;
                    }
                }
                CodeEvent::End(outcome) => break outcome,
            }
        };
        // Answered: nothing to stop when it's dropped.
        open.running = None;
        self.record_code_ran(&at, &outcome, &tally);
        output(&call, outcome, tally)
    }

    /// Spade's answer to one request of a running component.
    async fn code_host(
        &self,
        at: &At<'_>,
        link: &spade_core::package::link::Link,
        request: HostRequest,
        tally: &mut Tally,
    ) -> Answer {
        match request {
            HostRequest::Tools { name, input } => {
                // Only a component whose pinned entry imports Spade's tools may call them: the
                // worker's word for it is never enough.
                let answer = if at
                    .entry
                    .imports
                    .contains(&spade_core::package::code::Import::Tools)
                {
                    self.code_tool(at, &name, &input, tally).await
                } else {
                    Err("this component doesn't import spade:package/tools".to_owned())
                };
                let outcome = match &answer {
                    Ok(_) => "ran",
                    Err(why) if why == DECLINED => "declined",
                    Err(_) => "refused",
                };
                tally.calls.push(&name, outcome);
                answer
            }
            HostRequest::Http {
                method,
                url,
                headers,
                body,
            } => {
                if !at
                    .entry
                    .imports
                    .contains(&spade_core::package::code::Import::Http)
                {
                    return Err("this component doesn't import spade:package/http".to_owned());
                }
                let hosts =
                    code_run::reachable_hosts(&link.manifest.effects, &|key| link.on.contains(key));
                let host = code_run::http_host(&url, &hosts)?;
                // Each request is decided before its egress ticket, on the organization's policy
                // and the package's ceiling as they are now, in every mode.
                let ceiling = self.ceiling(at.conversation);
                let org = self.org_gate(at.conversation);
                let routed = code_run::http_route(code_run::HttpCall {
                    tainted: tally.tainted || !at.facts.in_view.is_empty(),
                    mode: self.autonomy(at.conversation),
                    ceiling: ceiling
                        .as_ref()
                        .map(|(bot, allows)| effect::ceiling::Ceiling {
                            bot,
                            allows: *allows,
                        }),
                    org: org
                        .as_ref()
                        .map(|(name, policy)| spade_core::org::Gate { org: name, policy }),
                });
                match routed {
                    Route::Run => {}
                    Route::Refuse(why) => return Err(autonomy::refused(&why)),
                    Route::Ask { line, .. } | Route::Review(Some(line)) => {
                        let shown = serde_json::json!({ "method": method, "url": url });
                        self.ask_for_code(at, code_run::HTTP, &shown, &line, tally)
                            .await?;
                    }
                    Route::Review(None) => {
                        let shown = serde_json::json!({ "method": method, "url": url });
                        self.ask_for_code(at, code_run::HTTP, &shown, code_run::NO_REVIEWER, tally)
                            .await?;
                    }
                }
                // What came back is a stranger's text, whatever it says.
                tally.tainted = true;
                if !tally.reached.contains(&host) && tally.reached.len() < MOST_REACHED {
                    tally.reached.push(host.clone());
                }
                let code = self.code().ok_or_else(|| "Spade is closing".to_owned())?;
                let sent = Request {
                    method,
                    url,
                    host,
                    headers,
                    body,
                };
                let answer = code.http().send(at.bot, sent).await?;
                Ok(HostValue::Response {
                    status: answer.status,
                    headers: answer.headers,
                    body: answer.body,
                })
            }
            HostRequest::KvGet { .. }
            | HostRequest::KvSet { .. }
            | HostRequest::KvDelete { .. }
            | HostRequest::KvKeys { .. } => {
                Err("spade:package/kv isn't available in this Spade yet".to_owned())
            }
        }
    }

    /// A `tools` call from code: one of Spade's own tools, gated as the model's calls are.
    async fn code_tool(&self, at: &At<'_>, name: &str, input: &str, tally: &mut Tally) -> Answer {
        if let Some(why) = code_run::call_refusal(name) {
            return Err(why);
        }
        if !self.uses_allow(at.conversation, name) {
            return Err(format!(
                "{name}: this bot's package doesn't use the module it belongs to"
            ));
        }
        let registry = self.registry_for(at.conversation);
        let (Some(def), Some(tool)) = (
            registry.get(name).cloned(),
            self.tools.get_for(at.conversation, name),
        ) else {
            return Err(format!("{name} isn't one of this bot's tools"));
        };
        let arguments: Value =
            serde_json::from_str(input).map_err(|_| format!("{name}'s input isn't JSON"))?;
        let declared = tool.effect(&arguments);
        let tainted = tally.tainted || !at.facts.in_view.is_empty();
        let checkpointed = self
            .contained_call(at.conversation, name, false, at.reply)
            .await;
        let ceiling = self.ceiling(at.conversation);
        let org = self.org_gate(at.conversation);
        let target = spade_core::outward::target(name, &arguments);
        let routed = code_run::route(code_run::CodeCall {
            tool: name,
            risk: def.risk,
            effect: declared,
            tainted,
            mode: self.autonomy(at.conversation),
            ceiling: ceiling
                .as_ref()
                .map(|(bot, allows)| effect::ceiling::Ceiling {
                    bot,
                    allows: *allows,
                }),
            granted: self.granted(at.conversation, name, &arguments, declared),
            checkpointed,
            credentials: autonomy::reaches_credentials(&arguments),
            target: target.as_deref(),
            org: org
                .as_ref()
                .map(|(name, policy)| spade_core::org::Gate { org: name, policy }),
        });
        match routed {
            Route::Run => {}
            Route::Refuse(why) => return Err(autonomy::refused(&why)),
            Route::Ask { line, .. } | Route::Review(Some(line)) => {
                self.ask_for_code(at, name, &arguments, &line, tally)
                    .await?;
            }
            Route::Review(None) => {
                self.ask_for_code(at, name, &arguments, code_run::NO_REVIEWER, tally)
                    .await?;
            }
        }
        let key = format!(
            "{}.{}/code/{}",
            at.conversation,
            at.call_id,
            tally.calls.len()
        );
        let output = tool.run_in(&key, arguments, at.facts).await;
        if output.untrusted || def.untrusted_output {
            tally.tainted = true;
        }
        if output.is_error {
            Err(output.content)
        } else {
            Ok(HostValue::Json {
                json: output.content,
            })
        }
    }

    /// Puts a call code asks for to the person, in the bot's conversation, and waits for their
    /// answer. `Ok` when they allowed it.
    async fn ask_for_code(
        &self,
        at: &At<'_>,
        name: &str,
        arguments: &Value,
        line: &str,
        tally: &mut Tally,
    ) -> Result<(), String> {
        tally.asked += 1;
        let asked_id = format!("{}{}{}", at.call_id, ASKED, tally.asked);
        let asked = Event::Known(Known::ApprovalRequested {
            reply: at.reply.to_owned(),
            call_id: asked_id.clone(),
            name: name.to_owned(),
            arguments: arguments.clone(),
            scope: None,
            reviewer_reason: Some(format!(
                "{}'s own code asks for this. {line}",
                at.entry.name
            )),
            ask: None,
            tool_key: None,
            app: None,
            acts_in: None,
            helper: None,
            launch: Some(Authorized::Contained),
            stopped: None,
        });
        match self.record_unless_stopped(at.conversation, at.reply, &asked) {
            Ok(true) => {}
            Ok(false) => return Err("it was stopped".to_owned()),
            Err(error) => return Err(format!("it couldn't be asked: {error}")),
        }
        let live = self.live(at.conversation);
        live.waiting_on_you
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.announce(at.conversation);
        let allowed = loop {
            let events = self
                .load(at.conversation)
                .map_err(|error| format!("its answer couldn't be read: {error}"))?;
            if let Some(allowed) = answer_to(&events, &asked_id) {
                break allowed;
            }
            // Stop clears what waits: nothing can be answered after it.
            if !Transcript::fold(events.iter()).awaiting.contains(&asked_id) {
                break false;
            }
            tokio::select! {
                () = live.wake.notified() => {}
                () = tokio::time::sleep(ANSWER_POLL) => {}
            }
        };
        live.waiting_on_you
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.announce(at.conversation);
        if allowed {
            Ok(())
        } else {
            Err(DECLINED.to_owned())
        }
    }

    fn record_code_ran(&self, at: &At<'_>, outcome: &Outcome, tally: &Tally) {
        let event = code_ran(at.reply, at.call_id, &at.entry.name, outcome, tally);
        if let Err(error) = self.record(at.conversation, &event) {
            tracing::warn!(%error, "a code call's use couldn't be stored");
        }
    }

    /// Closes what code asked the person for in a call that ended with no answer to its asks (a
    /// restart cut it short): those requests wait on nothing now.
    pub(super) fn close_code_asks(&self, id: &str, reply: &str, call_id: &str) {
        let Ok(events) = self.load(id) else {
            return;
        };
        let prefix = format!("{call_id}{ASKED}");
        let open: Vec<String> = Transcript::fold(events.iter())
            .awaiting
            .into_iter()
            .filter(|asked| asked.starts_with(&prefix))
            .collect();
        for asked in open {
            let closed = Event::Known(Known::ApprovalAnswered {
                reply: reply.to_owned(),
                call_id: asked,
                allowed: false,
                always: false,
                // Closed by Spade, not answered by anyone.
                by: None,
            });
            if let Err(error) = self.record(id, &closed) {
                tracing::warn!(%error, "a code call's request couldn't be closed");
            }
        }
    }
}

/// What a request code asked the person for is named: `<call id>-code-ask-<n>`, with no `/`, so
/// it is answered at the approvals path like any call.
const ASKED: &str = "-code-ask-";

/// The person's answer to `asked`, once given.
fn answer_to(events: &[Event], asked: &str) -> Option<bool> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ApprovalAnswered {
            call_id, allowed, ..
        }) if call_id == asked => Some(*allowed),
        _ => None,
    })
}

fn code_ran(
    reply: &str,
    call_id: &str,
    component: &str,
    outcome: &Outcome,
    tally: &Tally,
) -> Event {
    let (stats, cut) = match outcome {
        Outcome::Done { stats, .. } => (*stats, None),
        Outcome::Failed { stats, cut, .. } => (*stats, Some(cut_word(*cut).to_owned())),
    };
    Event::Known(Known::CodeRan {
        reply: reply.to_owned(),
        call_id: call_id.to_owned(),
        component: component.to_owned(),
        run_ms: stats.run_ms,
        fuel: stats.fuel,
        peak_memory: stats.peak_memory,
        cut,
        reached: tally.reached.clone(),
        calls: tally.calls.lines(),
    })
}

fn cut_word(cut: Cut) -> &'static str {
    match cut {
        Cut::Deadline => "deadline",
        Cut::Fuel => "fuel",
        Cut::Memory => "memory",
        Cut::Trap => "trap",
        Cut::Stopped => "stopped",
        Cut::Refused => "refused",
        Cut::Lost => "lost",
    }
}

fn stop_of(cut: Cut) -> Stop {
    match cut {
        Cut::Deadline => Stop::Deadline,
        Cut::Fuel => Stop::Fuel,
        Cut::Memory => Stop::Memory,
        Cut::Trap => Stop::Trap,
        Cut::Stopped => Stop::Stopped,
        Cut::Refused => Stop::Refused,
        Cut::Lost => Stop::Lost,
    }
}

/// The bot's answer: the component's output, its own failure, or one line on why it gave none.
/// Untrusted when anything it read was. A call cut off after it called a tool may have done
/// something, so it never reads as not run.
fn output(call: &CodeCall, outcome: Outcome, tally: Tally) -> ToolOutput {
    let out = match outcome {
        Outcome::Done {
            output: Ok(json), ..
        } => ToolOutput::ok(json),
        Outcome::Done {
            output: Err(why), ..
        } => ToolOutput::error(format!("{} answered an error: {why}", call.tool)),
        Outcome::Failed { cut, .. } => {
            let line = code_run::stopped_line(&call.entry, stop_of(cut));
            if cut == Cut::Lost || !tally.calls.is_empty() {
                ToolOutput::maybe_ran(line)
            } else {
                ToolOutput::error(line)
            }
        }
    };
    if tally.tainted { out.untrusted() } else { out }
}

/// A call still open when its run is dropped (Stop, Pause, Spade closing): the worker is told to
/// end it at once, and what it came to is stored as stopped, never done.
struct Open {
    running: Option<Running>,
    engine: Arc<Engine>,
    conversation: String,
    reply: String,
    call_id: String,
    component: String,
}

impl Drop for Open {
    fn drop(&mut self) {
        let Some(mut running) = self.running.take() else {
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            running.worker().kill();
            return;
        };
        let engine = self.engine.clone();
        let (conversation, reply, call_id, component) = (
            std::mem::take(&mut self.conversation),
            std::mem::take(&mut self.reply),
            std::mem::take(&mut self.call_id),
            std::mem::take(&mut self.component),
        );
        handle.spawn(async move {
            running.worker().stop(Some(running.id)).await;
            let outcome = loop {
                match running.next().await {
                    CodeEvent::Host { request, .. } => {
                        let _ = running
                            .reply(request, Err("it was stopped".to_owned()))
                            .await;
                    }
                    CodeEvent::End(outcome) => break outcome,
                }
            };
            let event = code_ran(&reply, &call_id, &component, &outcome, &Tally::default());
            if let Err(error) = engine.record(&conversation, &event) {
                tracing::warn!(%error, "a stopped code call's use couldn't be stored");
            }
        });
    }
}
