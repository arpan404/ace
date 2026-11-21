//! A step's tool calls: the gate and approvals. Running the allowed ones and storing each result
//! is [`run`]; classifying a call is [`classified`].

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use spade_core::autonomy::escalate::{self, Stopped};
use spade_core::autonomy::{self, Class, Mode, Runs};
use spade_core::context;
use spade_core::effect::{self, Place, Route};
use spade_core::event::Verdict;
use spade_core::event::{Authorized, Call, Known, since_arrival};
use spade_core::gate::{self, Decision};
use spade_core::maintenance::{Pause, Point};
use spade_core::question::{self, connect, suggest};
use spade_core::review;
use spade_core::tools::{CALL_TOOL, Risk, TOOL_SEARCH, unwrap_call_tool};
use spade_core::turn::{Pending, Status};
use spade_core::{Event, Transcript};
use tokio::sync::watch;

use super::Engine;
use super::apps::Requested;
use super::autonomy::Reviewed;
use super::classify::Screened;
use crate::tools::{ToolOutput, TurnFacts};
use crate::workspace::outside::{self, Bound, Warrant};
use crate::workspace::shell::Launch;
use again::{Held, asked_stopped};
pub(crate) use classified::CLASSIFY_TIME;
use classified::{Classified, UNREAD_OUTSIDE, classify, launch_for};
use run::{Holding, finish_tool, run_tools};

const DECLINED: &str = "The person declined this action.";

/// Memory tools whose writes become suggestions while only a tainted summary is in view.
fn suggestible(name: &str) -> bool {
    matches!(name, "memory_save" | "memory_update")
}

/// How handling a step's calls ended.
pub(super) enum Handled {
    Continue,
    Stopped,
    /// Spade is closing; tools still running were cut (the caller records each as maybe run).
    Paused,
    Failed(String),
}

/// Gates, runs or declines the last step's open calls.
pub(super) async fn handle_calls(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    events: &[Event],
    calls: Vec<Pending>,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Handled {
    let registry = engine.registry_for(id);
    let transcript = Transcript::fold(events);
    // A helper (ADR 0152) answers to its bot: the bot's "always" answers hold
    // for it, and what it would ask is asked in the bot's conversation.
    let helper = engine.helper_of(id);
    let bot_events = helper
        .as_ref()
        .map(|h| engine.load(&h.parent).unwrap_or_default());
    let untrusted = context::untrusted_turn(events, &registry);
    // What a tool keeps (a trusted file, a note, a proposal's source) answers to everything the
    // prompt shows, not just this turn: untrusted text from an earlier turn is still in view.
    let in_view = context::untrusted_in_view(events, &registry);
    // A note outlives the turn, so it answers to everything the prompt shows (ADR 0130): an
    // untrusted event from any turn since the last compaction makes a note ask. A tainted
    // summary alone does not block: a note saved or rewritten then is only suggested to the
    // person (memory.md), so one page read long ago never stops a routine's notes for good.
    let events_in_view = !context::untrusted_events_in_view(events, &registry).is_empty();
    let untrusted_memory = untrusted || events_in_view;
    let summary_only = !untrusted_memory && context::untrusted_summary(events);
    let facts = TurnFacts {
        untrusted: (!in_view.is_empty()).then(|| in_view.join(", ")),
        memory_suggests: summary_only,
        in_view: in_view.clone(),
        call: None,
    };
    // How the bot decides (ADR 0163, amendment 2), read once for the step's calls.
    let mode = engine.autonomy(id);
    let mut runnable: Vec<(Call, String, Value)> = Vec::new();
    // Calls let run outside the sandbox, by call id, with what the verdict that let each run was
    // given on (ADR 0144): checked again right before it starts.
    let mut bound: HashMap<String, Held> = HashMap::new();
    // What Spade's classifier read in a call it raised to the person, by call id: held to the
    // ceiling with the call's own effect when it starts.
    let mut raised_at: HashMap<String, effect::Effect> = HashMap::new();
    let mut waiting = false;
    // Started with no stored result. This worker runs every call it starts to its stored end, so
    // such a call ran in an earlier worker that was cut off: its outcome is unknown.
    let mut orphaned: Vec<(Call, String)> = Vec::new();
    for pending in calls {
        let (name, arguments) = resolve(&pending.call);
        match pending.status {
            // A packaged bot has only the tools of the modules it uses (ADR 0200 §4.3), checked
            // before any tool the turn loop answers itself: `tool_search`, `ask_user` and
            // `app_connect_request` are `apps`' and `ui`'s like any other.
            Status::New if !engine.uses_allow(id, &name) => {
                let missing = ToolOutput::error(ceiling::not_used(&name));
                finish_tool(engine, id, reply, &pending.call, &name, missing).await;
            }
            Status::New if name == TOOL_SEARCH => runnable.push((pending.call, name, arguments)),
            // A helper may use only what its profile allows (ADR 0152), checked before any tool
            // the turn loop answers itself: a helper's `ask_user` would wait on a question
            // nobody can see.
            Status::New if helper.is_some() && registry.get(&name).is_none() => {
                let refused = ToolOutput::error(helper_refusal(engine, id, &name));
                finish_tool(engine, id, reply, &pending.call, &name, refused).await;
            }
            // `ask_user` (ADR 0128, ADR 0154) waits like an approval until the person answers,
            // leaves it for later or dismisses it; asked with `wait: false` it never waits.
            Status::New if name == context::ASK_USER => match question::parse(&arguments) {
                Err(why) => {
                    let refused = ToolOutput::error(why);
                    finish_tool(engine, id, reply, &pending.call, &name, refused).await;
                }
                Ok(ask) => {
                    let mut asked = vec![Event::Known(Known::QuestionAsked {
                        reply: reply.to_owned(),
                        call_id: pending.call.id.clone(),
                        question: ask.summary(),
                        questions: ask.questions,
                        later: !ask.wait,
                    })];
                    if !ask.wait {
                        asked.push(Event::Known(Known::QuestionDeferred {
                            call_id: pending.call.id.clone(),
                            by_bot: true,
                        }));
                    }
                    match engine.record_all_unless_stopped(id, reply, &asked) {
                        Ok(true) => {}
                        Ok(false) => return Handled::Stopped,
                        Err(error) => return Handled::Failed(error.to_string()),
                    }
                    if ask.wait {
                        waiting = true;
                    } else {
                        let later = ToolOutput::ok(question::ASKED_FOR_LATER);
                        finish_tool(engine, id, reply, &pending.call, &name, later).await;
                    }
                }
            },
            // A bot asks the person for an app (ADR 0131, amendment 1): a connect card, which
            // waits like a question unless the bot has the app already or it can't be had yet.
            Status::New if name == connect::APP_CONNECT_REQUEST => {
                match engine
                    .app_connect_request(id, reply, &pending.call, &arguments)
                    .await
                {
                    Ok(Requested::Answered(output)) => {
                        finish_tool(engine, id, reply, &pending.call, &name, output).await;
                    }
                    Ok(Requested::Waiting) => waiting = true,
                    Ok(Requested::Stopped) => return Handled::Stopped,
                    Err(error) => return Handled::Failed(error),
                }
            }
            // A bot suggests a package (ADR 0200 §8): a suggest card from the market's signed
            // manifest, which waits like a question; a name the market doesn't list is refused.
            Status::New if name == suggest::PACKAGE_SUGGEST => {
                match engine
                    .package_suggest(id, reply, &pending.call, &arguments)
                    .await
                {
                    Ok(Requested::Answered(output)) => {
                        finish_tool(engine, id, reply, &pending.call, &name, output).await;
                    }
                    Ok(Requested::Waiting) => waiting = true,
                    Ok(Requested::Stopped) => return Handled::Stopped,
                    Err(error) => return Handled::Failed(error),
                }
            }
            // The task's goal and plan (ADR 0159) are answered from the events.
            Status::New if spade_core::goal::is_tool(&name) => {
                match engine.goal_call(id, reply, &name, &arguments) {
                    Ok(Some(output)) => {
                        finish_tool(engine, id, reply, &pending.call, &name, output).await;
                    }
                    Ok(None) => return Handled::Stopped,
                    Err(error) => return Handled::Failed(error.to_string()),
                }
            }
            // The decision log (ADR 0165) is answered from the events.
            Status::New if name == spade_core::decision::DECISION_LOG => {
                match engine.decision_call(id, reply, &pending.call.id, &arguments) {
                    Ok(Some(output)) => {
                        finish_tool(engine, id, reply, &pending.call, &name, output).await;
                    }
                    Ok(None) => return Handled::Stopped,
                    Err(error) => return Handled::Failed(error.to_string()),
                }
            }
            Status::Asked => waiting = true,
            // A call held on a Reconnect card: run again once the app is back, answered with
            // why not otherwise.
            Status::Answered if super::apps::held_for_reconnect(events, &pending.call.id) => {
                match super::apps::after_reconnect(events, &pending.call.id) {
                    super::apps::AfterReconnect::RunAgain => {
                        if let Some(raised) = review::raised(events, &pending.call.id) {
                            raised_at.insert(pending.call.id.clone(), raised);
                        }
                        runnable.push((pending.call, name, arguments));
                    }
                    super::apps::AfterReconnect::Answer(output) => {
                        finish_tool(engine, id, reply, &pending.call, &name, output).await;
                    }
                }
            }
            Status::Answered => {
                let said = question::call_result(events, &pending.call.id)
                    .unwrap_or_else(|| context::ANSWERED.to_owned());
                finish_tool(
                    engine,
                    id,
                    reply,
                    &pending.call,
                    &name,
                    ToolOutput::ok(said),
                )
                .await;
            }
            Status::New => match registry.get(&name) {
                None => {
                    let missing = ToolOutput::error(format!(
                        "There is no tool named {name}. Use tool_search to find tools."
                    ));
                    finish_tool(engine, id, reply, &pending.call, &name, missing).await;
                }
                Some(def) => {
                    let key = format!("{id}.{}", pending.call.id);
                    // Where the call runs and, for a command with no sandbox, what it runs and
                    // the files the reviewer must read (ADR 0171).
                    let Some(classified) =
                        classify(engine, id, &name, &key, &arguments, stop).await
                    else {
                        return Handled::Stopped;
                    };
                    // Spade couldn't read what it would run outside the sandbox at all: there is
                    // nothing to show the person or hold an answer to.
                    if matches!(&classified, Classified::Failed(fallback) if fallback.runs == Runs::AsksOutside)
                    {
                        match rule_verdict(
                            engine,
                            id,
                            reply,
                            events,
                            &pending.call,
                            &name,
                            Verdict::Refuse,
                            UNREAD_OUTSIDE,
                            None,
                            Authorized::Contained,
                        ) {
                            Ok(true) => {}
                            Ok(false) => return Handled::Stopped,
                            Err(error) => return Handled::Failed(error.to_string()),
                        }
                        let refused = ToolOutput::ok(autonomy::refused(UNREAD_OUTSIDE));
                        finish_tool(engine, id, reply, &pending.call, &name, refused).await;
                        continue;
                    }
                    // Part of what it would run outside the sandbox couldn't be read whole:
                    // nothing that runs it there on the rules, a grant or a reviewer can be held to
                    // it, so the person decides (ADR 0163, amendment 3).
                    let incomplete = matches!(&classified, Classified::Done(classed)
                        if classed.incomplete
                            && matches!(classed.runs, Runs::AsksOutside | Runs::Outside));
                    let classed = classified.classed();
                    // How far this call would launch: every verdict reused for it (an Always allow,
                    // a stored review, a grant) must have been given for that or wider.
                    let limit = authorized(classed.runs);
                    // What it runs as read now, which every verdict given on this reading binds:
                    // its start outside the sandbox must find it still so.
                    let read_bound = outside::binding(&classed);
                    // The binding of the verdict that decides it: this reading's, or a stored
                    // review's.
                    let mut verdict_bound = read_bound.clone();
                    let scope = engine
                        .tools
                        .get_for(id, &name)
                        .and_then(|tool| tool.always_scope_in(&key, &arguments));
                    // An Always allow holds only for the launch it was given for, or narrower; a
                    // whole-tool one records none, so it holds for a contained launch only.
                    // Only answers given on this machine count: a bot that moved here brought its
                    // history, not the person's consent (ADR 0187).
                    let always_in = |owner: &str, owned: &[Event], folded: &Transcript| {
                        let here = since_arrival(owned);
                        match &scope {
                            Some(scope) => {
                                allowed_always_for(engine, owner, here, &name, scope, limit)
                            }
                            None if here.len() == owned.len() => {
                                limit == Authorized::Contained
                                    && folded.always_allowed.iter().any(|t| t == &name)
                            }
                            None => {
                                limit == Authorized::Contained
                                    && Transcript::fold(here)
                                        .always_allowed
                                        .iter()
                                        .any(|t| t == &name)
                            }
                        }
                    };
                    let always = match (&helper, &bot_events) {
                        (Some(h), Some(owned)) => {
                            always_in(id, events, &transcript)
                                || always_in(&h.parent, owned, &Transcript::fold(owned.as_slice()))
                        }
                        _ => always_in(id, events, &transcript),
                    };
                    let tainted = match def.risk {
                        // Only saving and rewriting can wait as a suggestion; any other change to
                        // notes (forgetting one) asks while the summary is tainted.
                        Risk::Memory => untrusted_memory || (summary_only && !suggestible(&name)),
                        _ => untrusted,
                    };
                    let rule = gate::decide(def.risk, always, tainted);
                    // What it does, as the tool declares it once.
                    let declared = engine
                        .tools
                        .get_for(id, &name)
                        .and_then(|tool| tool.effect(&arguments));
                    // A sandboxed command, or a file write in the workspace: checkpointed first;
                    // when the checkpoint can't be taken, reviewed instead.
                    let held = engine
                        .contained_call(id, &name, classed.runs == Runs::Sandbox, reply)
                        .await;
                    let place = match classed.runs {
                        Runs::Host => Place::Host,
                        Runs::Sandbox if held => Place::Sandbox,
                        Runs::Sandbox => Place::Unprotected,
                        Runs::AsksOutside => Place::AsksOutside,
                        Runs::Outside => Place::Unsandboxed(classed.class),
                    };
                    // An undeclared tool's answer is kept under the bot and the tool's own
                    // identity, never its offered name alone; a helper reads its bot's.
                    let tool_key = match declared {
                        Some(_) => None,
                        None => engine
                            .tools
                            .get_for(id, &name)
                            .map(|tool| engine.tool_key(id, tool.identity())),
                    };
                    let remembered = tool_key.as_deref().and_then(|key| {
                        effect::remembered(since_arrival(events), key).or_else(|| {
                            bot_events
                                .as_deref()
                                .and_then(|owned| effect::remembered(since_arrival(owned), key))
                        })
                    });
                    let target = spade_core::outward::target(&name, &arguments);
                    // A driving step: where it acts, asked of ace now, whether that place is the
                    // person's alone, and whether they allowed it for the bot (ADR 0171,
                    // amendment 3).
                    let driven = match declared {
                        Some(effect::Effect::Drive) => {
                            Some(engine.drive_step(id, &key, &name, &arguments).await)
                        }
                        _ => None,
                    };
                    let drive =
                        driven
                            .as_ref()
                            .map_or_else(effect::Drive::default, |step| effect::Drive {
                                target: step
                                    .place
                                    .as_ref()
                                    .map(effect::drive::Place::shown)
                                    .map_err(|why| *why),
                                sensitive: step.sensitive,
                                granted: step
                                    .place
                                    .as_ref()
                                    .is_ok_and(|place| engine.drive_granted(id, place)),
                                // An ace from before `expect` can't hold the step to its place.
                                bound: step.place.as_ref().is_ok_and(|place| {
                                    !effect::drive::needs_binding(&name, &arguments, place)
                                        || engine.takes_expect(id, &name)
                                }),
                            });
                    let acts_in = driven
                        .as_ref()
                        .and_then(|step| step.place.as_ref().ok().cloned());
                    // A connector's or plugin's tool that can reach anyone: its server says what
                    // it is, and only one sealed offline with no credentials can't.
                    let remote = engine
                        .tools
                        .get_for(id, &name)
                        .is_some_and(|tool| tool.hints().is_some() && !tool.sealed());
                    // One reading of the classifier for this call, for routing and screening.
                    let classifier = engine.classifier_ready();
                    // A packaged bot's declared effects, as the person left them on, for it and
                    // everything under it (ADR 0200 §3.4).
                    let ceiling = engine.ceiling(id);
                    // A shared bot's organization, as its policy stands (ADR 0206 §3).
                    let org = engine.org_gate(id);
                    let gate = effect::Call {
                        tool: &name,
                        rule,
                        risk: def.risk,
                        always,
                        effect: declared,
                        remembered,
                        place,
                        // Anything untrusted the prompt shows, from any turn since compaction.
                        tainted: !in_view.is_empty(),
                        // The sandbox's deny-list holds a sandboxed call; anything else that
                        // names a credential place, or a script it runs that reads one, is
                        // refused on every level.
                        credentials: (place != Place::Sandbox || remote)
                            && (classed.credentials || autonomy::reaches_credentials(&arguments)),
                        standing: autonomy::STANDING.contains(&name.as_str()),
                        fits: autonomy::fits_review(&arguments, &classed.shown),
                        // A grant records no launch: it holds for a contained launch only.
                        granted: if limit == Authorized::Contained {
                            engine.granted(id, &name, &arguments, declared)
                        } else {
                            effect::Granted::No
                        },
                        checkpointed: held && classed.runs == Runs::Host,
                        target: target.as_deref(),
                        drive,
                        mode,
                        remote,
                        classifier,
                        ceiling: ceiling
                            .as_ref()
                            .map(|(bot, allows)| effect::ceiling::Ceiling {
                                bot,
                                allows: *allows,
                            }),
                        command: ceiling::outside_class(&classed),
                        // A server's destructive hint asks each call (ADR 0202 §2).
                        destructive: engine
                            .tools
                            .get_for(id, &name)
                            .and_then(|tool| tool.hints())
                            .is_some_and(effect::asks_each_call),
                        org: org
                            .as_ref()
                            .map(|(name, policy)| spade_core::org::Gate { org: name, policy }),
                    };
                    // The ceiling first, before any route of Spade's own: nothing a packaged bot
                    // does, a bot it makes for the person included, gets past what its package
                    // declared.
                    let own = effect::ceiling_refusal(&gate).map(Route::Refuse);
                    // A bot's own task, name and face are decided next, in every access level:
                    // with anything untrusted in view, a change goes to the person.
                    let own = own.or_else(|| {
                        spade_core::self_edit::route(
                            &name,
                            untrusted || !in_view.is_empty(),
                            spade_core::self_edit::naming_open(events),
                        )
                    });
                    // A bot made for the person, or added to a club: its setting, and the person
                    // whenever untrusted content is in view (ADR 0161, amendment 1).
                    let own = own.or_else(|| {
                        spade_core::made::route(
                            &name,
                            &arguments,
                            untrusted || !in_view.is_empty(),
                            engine.may_create(id),
                        )
                    });
                    let route = match own {
                        Some(route) => route,
                        None => effect::route(gate),
                    };
                    // An app's write in Full access runs counting on the screening.
                    let required = remote && declared != Some(effect::Effect::Read);
                    let screening = |concern: bool| super::classify::Screening {
                        launch: limit,
                        ready: classifier,
                        required,
                        call: &pending.call,
                        name: &name,
                        arguments: &arguments,
                        classed: &classed,
                        hints: engine.tools.get_for(id, &name).and_then(|t| t.hints()),
                        reviewing: spade_classify::Reviewing {
                            plain_command: classed.runs == Runs::Outside
                                && classed.class == Class::Inside
                                && !classed.credentials,
                            tainted: !in_view.is_empty(),
                            runs_files: !classed.shown.is_empty(),
                            standing: autonomy::STANDING.contains(&name.as_str()),
                            concern,
                        },
                    };
                    // Which of Spade's judges put the call to the person, when one did.
                    let mut stopped = None;
                    // What Spade's classifier read in it, when it raised it to the person.
                    let mut raised = None;
                    // In Full access nothing is reviewed, but Spade's classifier may still raise a
                    // command outside the sandbox or an app's tool it reads as a hard stop.
                    let route = match route {
                        route if incomplete => {
                            let route = escalate::incomplete(route);
                            if matches!(route, Route::Ask { .. }) {
                                stopped = Some(Stopped::Incomplete);
                            }
                            route
                        }
                        Route::Run
                            if mode == Mode::FullAccess && (place != Place::Sandbox || remote) =>
                        {
                            engine.screening_now();
                            match engine.raise_only(id, reply, events, &screening(false)) {
                                Ok(Screened::Ask(line, read)) => {
                                    raised = read;
                                    stopped = Some(Stopped::Classifier);
                                    Route::Ask { line, ask: None }
                                }
                                Ok(Screened::Stopped) => return Handled::Stopped,
                                Ok(Screened::Run) => Route::Run,
                                // Refused before (by the reviewer or the rules, then stored):
                                // still refused, never run because the bot is in Full access now.
                                Ok(Screened::Refuse(reason)) => {
                                    let refused = ToolOutput::ok(autonomy::refused(&reason));
                                    finish_tool(engine, id, reply, &pending.call, &name, refused)
                                        .await;
                                    continue;
                                }
                                // It couldn't be screened after all: the reviewer decides.
                                Ok(Screened::Review) => {
                                    Route::Review(Some(effect::NO_CLASSIFIER.to_owned()))
                                }
                                Err(error) => return Handled::Failed(error.to_string()),
                            }
                        }
                        route => route,
                    };
                    let mut ask = None;
                    let mut reviewer_reason = None;
                    let rule_ran = route == Route::Run;
                    let mut decision = match route {
                        Route::Run => Decision::Run,
                        // The person decides, with the line the request shows.
                        Route::Ask {
                            line: reason,
                            ask: why,
                        } => {
                            match rule_verdict(
                                engine,
                                id,
                                reply,
                                events,
                                &pending.call,
                                &name,
                                Verdict::Escalate,
                                &reason,
                                // Bound to the files it runs as they are now: a command the
                                // person allows outside the sandbox runs only if they still are.
                                read_bound.stored(),
                                limit,
                            ) {
                                Ok(true) => {}
                                Ok(false) => return Handled::Stopped,
                                Err(error) => return Handled::Failed(error.to_string()),
                            }
                            reviewer_reason = Some(reason);
                            ask = why;
                            Decision::Ask
                        }
                        Route::Refuse(reason) => {
                            match rule_verdict(
                                engine,
                                id,
                                reply,
                                events,
                                &pending.call,
                                &name,
                                Verdict::Refuse,
                                &reason,
                                None,
                                limit,
                            ) {
                                Ok(true) => {}
                                Ok(false) => return Handled::Stopped,
                                Err(error) => return Handled::Failed(error.to_string()),
                            }
                            let refused = ToolOutput::ok(autonomy::refused(&reason));
                            finish_tool(engine, id, reply, &pending.call, &name, refused).await;
                            continue;
                        }
                        Route::Review(concern) => {
                            // Spade's classifier first (ADR 0172): it may settle a plain command
                            // as low-risk or raise a person-only effect; otherwise it abstains
                            // and the reviewer decides as before.
                            let screening = screening(concern.is_some());
                            engine.screening_now();
                            let screened = match engine.screen(id, reply, events, &screening) {
                                Ok(screened) => screened,
                                Err(error) => return Handled::Failed(error.to_string()),
                            };
                            match screened {
                                Screened::Run => Decision::Run,
                                Screened::Ask(line, read) => {
                                    raised = read;
                                    reviewer_reason = Some(line);
                                    stopped = Some(Stopped::Classifier);
                                    Decision::Ask
                                }
                                Screened::Stopped => return Handled::Stopped,
                                // `screen` leaves a stored refusal to the reviewer's path.
                                Screened::Refuse(reason) => {
                                    let refused = ToolOutput::ok(autonomy::refused(&reason));
                                    finish_tool(engine, id, reply, &pending.call, &name, refused)
                                        .await;
                                    continue;
                                }
                                Screened::Review => {
                                    let def = def.clone();
                                    let under = super::autonomy::Under {
                                        call: &pending.call,
                                        name: &name,
                                        arguments: &arguments,
                                        def: &def,
                                        shown: &classed.shown,
                                        bound: read_bound.stored(),
                                        concern: concern.as_deref(),
                                        acts_in: acts_in.as_ref(),
                                        launch: limit,
                                    };
                                    // An approval is bound to the files as the reviewer read them: the
                                    // stored one's, or these when this review is the first.
                                    if review::stored(events, &pending.call.id, limit).is_some() {
                                        verdict_bound = Bound::from_stored(review::bound(
                                            events,
                                            &pending.call.id,
                                        ));
                                    }
                                    match super::autonomy::review(
                                        engine, id, reply, events, &registry, under, stop,
                                    )
                                    .await
                                    {
                                        Reviewed::Run => Decision::Run,
                                        // Refused or undecided: the person decides, told why,
                                        // never the bot told no (ADR 0163, amendment 3).
                                        Reviewed::Escalate(reason) => {
                                            reviewer_reason = Some(reason);
                                            stopped = Some(Stopped::Reviewer);
                                            Decision::Ask
                                        }
                                        Reviewed::Stopped => return Handled::Stopped,
                                    }
                                }
                            }
                        }
                    };
                    // The model review (ADR 0135) may turn a run into a question, never the
                    // other way round; a call the auto-review approved was reviewed already.
                    // A sandboxed call is the OS's to decide: no review of any kind (ADR 0171).
                    // In Full access the person chose no reviewer (ADR 0163, amendment 2).
                    if rule_ran
                        && mode == Mode::AutoReview
                        && (place != Place::Sandbox || remote)
                        && review::reviewed(def.risk, decision)
                        && engine.review_on(id)
                    {
                        let def = def.clone();
                        match super::review::call(
                            engine,
                            id,
                            reply,
                            events,
                            &registry,
                            &pending.call,
                            &name,
                            &arguments,
                            &def,
                            limit,
                            stop,
                        )
                        .await
                        {
                            super::review::Reviewed::Allow => {}
                            super::review::Reviewed::Escalate(reason) => {
                                reviewer_reason = Some(reason);
                                stopped = Some(Stopped::SecondReview);
                                decision = Decision::Ask;
                            }
                            super::review::Reviewed::Stopped => return Handled::Stopped,
                        }
                    }
                    match decision {
                        Decision::Run => {
                            // What "always" allowed, checked again where it runs (ADR 0142).
                            if let Some(scope) = &scope {
                                engine.allow_scope(&key, scope);
                            }
                            // What the gate decided, carried to the launch unchanged: a call it
                            // decided in the sandbox's light may only launch contained. With it
                            // the warrant of whichever verdict let it run (the rules, an Always
                            // allow, a grant, the classifier, the reviewer, one stored): its
                            // launch limit and what it ran, which its start outside the sandbox
                            // must pass.
                            let launch = launch_for(classed.runs);
                            if launch == Launch::Outside {
                                let held = Held {
                                    bound: verdict_bound.stored(),
                                    limit,
                                    incomplete: false,
                                    recheck: true,
                                    scope: scope.clone(),
                                    ask: None,
                                };
                                bound.insert(pending.call.id.clone(), held);
                            }
                            let warrant = Warrant {
                                limit,
                                bound: verdict_bound,
                                incomplete: false,
                            };
                            engine.authorize(&key, launch, warrant);
                            // A driving step runs only where it was decided on.
                            if let Some(place) = acts_in {
                                // Run by the reviewer's word alone, unless an Always allow of
                                // the person's let it through; in Full access by no one's, so
                                // held to its place as strictly.
                                engine.decide_place(
                                    &key,
                                    place,
                                    !rule_ran || mode == Mode::FullAccess,
                                );
                            }
                            runnable.push((pending.call, name, arguments));
                        }
                        Decision::Ask => {
                            // Raised to the person for an effect its package never declared, or
                            // the person turned off: refused, never asked (ADR 0200 §3.4).
                            let raised =
                                raised.or_else(|| review::raised(events, &pending.call.id));
                            if let Some(why) =
                                ceiling::raised_refusal(ceiling.as_ref(), raised, place, remote)
                            {
                                let refused = ToolOutput::ok(autonomy::refused(&why));
                                finish_tool(engine, id, reply, &pending.call, &name, refused).await;
                                continue;
                            }
                            waiting = true;
                            // A driving step asked for any reason (its place, the reviewer, the
                            // classifier) offers to allow its app or site, where that may be.
                            if driven.is_some() {
                                ask = Some(effect::Ask::Drive);
                            }
                            // Allowing the app is offered only where it would stop the asking.
                            let app = acts_in
                                .as_ref()
                                .filter(|_| drive.sensitive.is_none() && drive.bound)
                                .filter(|place| {
                                    place.grant().is_some_and(|scope| {
                                        spade_core::grant::check(&scope, &|_| None).is_ok()
                                    })
                                })
                                .map(|place| place.shown().to_owned());
                            let asked = Event::Known(Known::ApprovalRequested {
                                reply: reply.to_owned(),
                                call_id: pending.call.id.clone(),
                                name,
                                arguments,
                                scope,
                                reviewer_reason,
                                ask,
                                tool_key: (ask == Some(effect::Ask::Undeclared))
                                    .then_some(tool_key)
                                    .flatten(),
                                app,
                                acts_in: acts_in.map(Box::new),
                                helper: None,
                                // The most the person's answer lets it run. What it ran is
                                // the binding of the verdict stored just before, which asked.
                                launch: Some(limit),
                                stopped,
                            });
                            // Never asked once the reply is stopped, so no answer can allow it.
                            let recorded = match &helper {
                                Some(helper) => engine.ask_for_helper(helper, reply, &asked),
                                None => engine.record_unless_stopped(id, reply, &asked),
                            };
                            match recorded {
                                Ok(true) => {}
                                Ok(false) => return Handled::Stopped,
                                Err(error) => return Handled::Failed(error.to_string()),
                            }
                        }
                    }
                }
            },
            Status::Allowed => {
                // What the person allowed, as it was asked: checked again where it runs, so a
                // terminal that changed since (or was reset by a restart) is never run in.
                let key = format!("{id}.{}", pending.call.id);
                if let Some(scope) = asked_scope(events, &pending.call.id) {
                    engine.allow_scope(&key, &scope);
                }
                // The person allowed it outside the sandbox: asked so, or asked while the bot's
                // commands ran outside it and still do.
                let outside = asked_outside(events, &pending.call.id);
                let (launch, now) = if outside {
                    (Launch::Outside, Authorized::Outside)
                } else {
                    let Some(now) = classify(engine, id, &name, &key, &arguments, stop).await
                    else {
                        return Handled::Stopped;
                    };
                    let runs = now.classed().runs;
                    (launch_for(runs), authorized(runs))
                };
                // Never wider than where it was decided to run when the person was asked (a
                // bot's commands moved outside meanwhile): it needs a fresh decision.
                // An answer with no recorded launch (an older build's, even one asked to run
                // outside) is ambiguous: it holds for a contained launch only.
                let allowed_to = Authorized::stored(asked_launch(events, &pending.call.id));
                if now > allowed_to {
                    let wider = ToolOutput::ok(autonomy::refused(WIDER_THAN_ALLOWED));
                    finish_tool(engine, id, reply, &pending.call, &name, wider).await;
                    continue;
                }
                // The person's answer's warrant: the launch they were asked about, and what the
                // command ran then, as the verdict that asked them recorded it (every ask stores
                // one first; none recorded: nothing). Asked because part of it couldn't be read
                // whole, their Allow lets it start so, if what could be read is unchanged.
                let stopped = asked_stopped(events, &pending.call.id);
                let warrant = Warrant {
                    limit: allowed_to,
                    bound: Bound::from_stored(review::bound(events, &pending.call.id)),
                    incomplete: stopped == Some(Stopped::Incomplete),
                };
                if launch == Launch::Outside {
                    let held = Held {
                        bound: warrant.bound.stored(),
                        limit: allowed_to,
                        incomplete: warrant.incomplete,
                        // Asked again because it couldn't be read before it started: the check
                        // at the spawn reads it, and holds it to what it was allowed on.
                        recheck: stopped != Some(Stopped::Unread),
                        scope: asked_scope(events, &pending.call.id),
                        ask: outside.then_some(effect::Ask::OutsideSandbox),
                    };
                    bound.insert(pending.call.id.clone(), held);
                }
                engine.authorize(&key, launch, warrant);
                // A driving step runs only where the person was told it acts.
                if let Some(place) = asked_place(events, &pending.call.id) {
                    engine.decide_place(&key, place, false);
                }
                if let Some(raised) = review::raised(events, &pending.call.id) {
                    raised_at.insert(pending.call.id.clone(), raised);
                }
                runnable.push((pending.call, name, arguments));
            }
            Status::Declined => {
                let declined = ToolOutput::error(DECLINED);
                finish_tool(engine, id, reply, &pending.call, &name, declined).await;
            }
            Status::Awaiting => waiting = true,
            Status::Running => orphaned.push((pending.call, name)),
        }
    }
    for (call, name) in orphaned {
        let unknown = ToolOutput::maybe_ran(context::MAYBE_RAN);
        finish_tool(engine, id, reply, &call, &name, unknown).await;
    }
    if !runnable.is_empty() {
        let held = Holding {
            bound: &bound,
            raised: &raised_at,
        };
        return run_tools(engine, id, reply, runnable, held, &facts, stop, pause).await;
    }
    if waiting {
        let live = engine.live(id);
        live.waiting_on_you
            .store(true, std::sync::atomic::Ordering::SeqCst);
        engine.announce(id);
        let handled = tokio::select! {
            _ = live.wake.notified() => Handled::Continue,
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    Handled::Stopped
                } else {
                    Handled::Continue
                }
            }
            _ = super::turn::pausing(pause, Point::WaitingOnYou) => Handled::Paused,
        };
        live.waiting_on_you
            .store(false, std::sync::atomic::Ordering::SeqCst);
        engine.announce(id);
        return handled;
    }
    Handled::Continue
}

/// What a helper is told about a tool its profile leaves out: refused when its bot has it or no
/// helper may have it, missing otherwise.
fn helper_refusal(engine: &Engine, id: &str, name: &str) -> String {
    let barred = spade_core::helper::NEVER.contains(&name)
        || engine.tools.registry_for(id).get(name).is_some();
    if barred {
        format!("Refused: a helper cannot use {name}. Finish the task with your tools and answer.")
    } else {
        format!("There is no tool named {name}. Use tool_search to find tools.")
    }
}

/// Stores a verdict the rules reached (ADR 0144) unless one is stored for the call already, as
/// after a restart. `Ok(false)` when the reply was stopped.
#[allow(clippy::too_many_arguments)]
fn rule_verdict(
    engine: &Engine,
    id: &str,
    reply: &str,
    events: &[Event],
    call: &Call,
    name: &str,
    verdict: Verdict,
    reason: &str,
    bound: Option<String>,
    launch: Authorized,
) -> Result<bool, spade_store::StoreError> {
    if review::stored(events, &call.id, launch).is_some() {
        return Ok(true);
    }
    super::autonomy::record_rule(
        engine, id, reply, call, name, verdict, reason, bound, launch,
    )
}

/// Whether the person answered "always" to an earlier call of `name` with the same scope (for
/// the shell, the exact same command). Read from the conversation's own events, so it holds for
/// the bot across restarts and compaction.
fn allowed_always_for(
    engine: &Engine,
    id: &str,
    events: &[Event],
    name: &str,
    scope: &str,
    launch: Authorized,
) -> bool {
    let Some(tool) = engine.tools.get_for(id, name) else {
        return false;
    };
    events.iter().any(|event| match event {
        Event::Known(Known::ApprovalAnswered {
            call_id,
            allowed: true,
            always: true,
            ..
        }) => events.iter().any(|asked| {
            matches!(asked, Event::Known(Known::ApprovalRequested { call_id: c, name: n, arguments, scope: asked_scope, launch: given, .. })
                if c == call_id && n == name
                    && asked_scope.clone().or_else(|| tool.always_scope(arguments)).as_deref() == Some(scope)
                    // Given for this launch or a wider one; none recorded is contained only.
                    && Authorized::stored(*given).covers(launch))
        }),
        _ => false,
    })
}

/// The scope the call `call_id` was asked with, when its tool gave one.
fn asked_scope(events: &[Event], call_id: &str) -> Option<String> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ApprovalRequested {
            call_id: c, scope, ..
        }) if c == call_id => scope.clone(),
        _ => None,
    })
}

/// Where the person was told the driving step `call_id` acts, when Spade could tell.
fn asked_place(events: &[Event], call_id: &str) -> Option<effect::drive::Place> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ApprovalRequested {
            call_id: c,
            acts_in,
            ..
        }) if c == call_id => acts_in.as_deref().cloned(),
        _ => None,
    })
}

/// Whether the call `call_id` was asked about as a command to run outside the sandbox.
/// Where a call may run on the person's answer, as it was decided when they were asked.
fn asked_launch(events: &[Event], call_id: &str) -> Option<Authorized> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ApprovalRequested {
            call_id: c, launch, ..
        }) if c == call_id => *launch,
        _ => None,
    })
}

/// Where a call that runs where `runs` says may run on an answer to it.
fn authorized(runs: Runs) -> Authorized {
    match runs {
        // Spade, ace or an app runs it: no command is launched, so nothing wider than a
        // contained one.
        Runs::Sandbox | Runs::Host => Authorized::Contained,
        Runs::AsksOutside | Runs::Outside => Authorized::Outside,
    }
}

/// Why an allowed call didn't start: it would run somewhere wider now.
const WIDER_THAN_ALLOWED: &str = "Where it would run now is wider than when the person allowed \
     it (the bot's commands may have moved outside the sandbox), so that answer doesn't cover it. \
     Call it again to have it decided afresh.";

fn asked_outside(events: &[Event], call_id: &str) -> bool {
    events.iter().any(|event| {
        matches!(event, Event::Known(Known::ApprovalRequested {
            call_id: c, ask: Some(effect::Ask::OutsideSandbox), ..
        }) if c == call_id)
    })
}

/// A call's real tool and arguments: `call_tool` names its tool inside.
fn resolve(call: &Call) -> (String, Value) {
    if call.name == CALL_TOOL
        && let Some((name, arguments)) = unwrap_call_tool(&call.arguments)
    {
        return (name, arguments);
    }
    (call.name.clone(), call.arguments.clone())
}

mod again;
mod ceiling;
mod classified;
mod run;
