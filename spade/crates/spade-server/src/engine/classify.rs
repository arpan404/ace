//! Spade's own classifier between the deterministic gate and the reviewer (ADR 0172): for a call
//! the gate sent to review, the built-in model may settle a plain command as low-risk (it runs),
//! raise a call it reads as a person-only effect (the person decides), or abstain (the reviewer
//! decides, as without it). It only ever sees calls the rules already sent to review, so it
//! never changes what they decided. The decision logic is `spade_classify`; this is the I/O
//! around it: the setting, the stored verdict and a local log of each decision (class and
//! confidence, never the call's arguments).

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

use spade_classify::{Decision, Effect, Hardening, Mcp, Model, Reviewing, Screen, Subject};
use spade_core::Event;
use spade_core::autonomy::{Classed, Runs};
use spade_core::event::{Call, Verdict};
use spade_core::review;

use super::Engine;

/// What the classifier came to for one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Screened {
    /// Clearly low-risk: it runs, with no reviewer.
    Run,
    /// A person-only effect: the person decides, with this line.
    Ask(String),
    /// The reviewer decides.
    Review,
    /// The reply was stopped meanwhile: nothing runs and nothing is asked.
    Stopped,
}

/// One call the gate sent to review.
pub(super) struct Screening<'a> {
    pub call: &'a Call,
    pub name: &'a str,
    pub arguments: &'a Value,
    pub classed: &'a Classed,
    /// For a connector's or plugin's tool, what its server says of it.
    pub hints: Option<Mcp>,
    pub reviewing: Reviewing,
}

/// What the stored verdict of a settled call says, with the name of the overrides it runs with
/// (ADR 0172, amendment 3), so the launch and a restart can check them.
fn settled(hardening: &Hardening) -> String {
    format!(
        "Spade's classifier read it as clearly low-risk; it runs with Spade's configuration overrides ({}).",
        hardening.digest()
    )
}

/// What the person is told when a call the classifier settled can't run in its hard form now.
const NO_FORM: &str = "Spade can't run it with its configuration overrides now, so you decide.";

/// The request's line for a person-only effect the classifier reads.
pub fn line(effect: Effect) -> &'static str {
    use spade_core::effect::{CHANGES_ACCESS, DRIVES, SENDS_AS_YOU, SPENDS};
    match effect {
        Effect::Pay => SPENDS,
        Effect::SendAsPerson => SENDS_AS_YOU,
        Effect::Drive => DRIVES,
        Effect::ChangeAccess => CHANGES_ACCESS,
        _ => "It may read sign-in tokens or keys, so you decide.",
    }
}

/// What the model is shown: a command that runs with no sandbox, or a connector's or plugin's
/// tool. Spade's and ace's own tools declare what they do; the model isn't asked about them.
fn subject<'a>(s: &'a Screening<'_>) -> Option<Subject<'a>> {
    if s.classed.runs == Runs::Outside
        && let Some(command) = s.arguments.get("command").and_then(Value::as_str)
    {
        return Some(Subject::Shell {
            command,
            workspace: s.classed.workspace.as_deref(),
        });
    }
    s.hints.map(|hints| Subject::Tool {
        name: s.name,
        arguments: s.arguments,
        hints,
    })
}

/// The model's decision (`spade_classify::Model::decide`).
pub fn decide(
    model: &Model,
    subject: &Subject<'_>,
    reviewing: Reviewing,
    config_clean: spade_classify::ConfigTools,
    sandboxable: bool,
) -> Decision {
    let decision = model.decide(subject, reviewing, config_clean);
    // A settled command's reads are contained by a read-only OS sandbox (ADR 0172, amendment 7).
    // Where the machine has none, nothing settles: the reviewer decides.
    if !sandboxable && decision.screen == Screen::LowRisk {
        return Decision {
            screen: Screen::Abstain,
            hardening: None,
            ..decision
        };
    }
    decision
}

/// Whether the call's stored verdict is this classifier's.
fn settled_by_classifier(events: &[Event], call_id: &str) -> bool {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            Event::Known(spade_core::event::Known::CallReviewed {
                call_id: c, model, ..
            }) if c == call_id => Some(model.starts_with("spade-classify/")),
            _ => None,
        })
        .unwrap_or(false)
}

impl Engine {
    /// The form the classifier settled the call `key` for, taken (each call launches once). The
    /// launch must run it in exactly this form, or not at all.
    pub(crate) fn take_hardening(&self, key: &str) -> Option<Hardening> {
        self.decisions.take(key)
    }

    /// Whether Spade's classifier is on (the machine's setting, on unless turned off).
    pub(crate) fn classifier_on(&self) -> bool {
        self.oversight().map_or(true, |global| global.classifier)
    }

    /// Runs the classifier on a call the gate sent to review, storing what it settled or raised
    /// as the call's verdict, so a restart reaches the same answer without asking it again.
    pub(super) fn screen(
        &self,
        id: &str,
        reply: &str,
        events: &[Event],
        s: &Screening<'_>,
    ) -> Result<Screened, spade_store::StoreError> {
        let key = format!("{id}.{}", s.call.id);
        if let Some((verdict, reason)) = review::stored(events, &s.call.id) {
            // A call this classifier settled before a restart runs only in the form it was
            // settled for, derived again from the command and checked against the record.
            if verdict == Verdict::Allow && settled_by_classifier(events, &s.call.id) {
                let form = s
                    .arguments
                    .get("command")
                    .and_then(Value::as_str)
                    .and_then(spade_classify::hardening);
                return Ok(match form {
                    Some(form) if reason == settled(&form) => {
                        self.decisions.mark(&key, form);
                        Screened::Run
                    }
                    _ => Screened::Ask(NO_FORM.to_owned()),
                });
            }
            return Ok(Screened::Review);
        }
        if !self.classifier_on() {
            return Ok(Screened::Review);
        }
        let (Some(model), Some(subject)) = (Model::embedded(), subject(s)) else {
            return Ok(Screened::Review);
        };
        let Decision {
            prediction,
            screen,
            hardening,
        } = decide(
            model,
            &subject,
            s.reviewing,
            s.classed.config_clean,
            s.classed.sandboxable,
        );
        let (top, confidence) = prediction.top();
        self.decisions.append(&Logged {
            at: self.clock.now_ms(),
            conversation: id,
            call_id: &s.call.id,
            tool: s.name,
            subject: if matches!(subject, Subject::Shell { .. }) {
                "shell"
            } else {
                "tool"
            },
            class: top.name(),
            confidence,
            low_risk: prediction.low_risk(),
            person: prediction.person_only().1,
            decision: match screen {
                Screen::LowRisk => "low_risk",
                Screen::Person(_) => "person",
                Screen::Abstain => "abstain",
            },
            model: model.id(),
        });
        let (verdict, reason, screened) = match screen {
            Screen::Abstain => return Ok(Screened::Review),
            Screen::LowRisk => {
                // Settled only with the form it runs in; recorded with the verdict and taken by
                // the launch, which checks it again.
                let Some(form) = hardening else {
                    return Ok(Screened::Review);
                };
                let reason = settled(&form);
                self.decisions.mark(&key, form);
                (Verdict::Allow, reason, Screened::Run)
            }
            Screen::Person(effect) => {
                let line = line(effect).to_owned();
                (Verdict::Escalate, line.clone(), Screened::Ask(line))
            }
        };
        let event = Event::Known(spade_core::event::Known::CallReviewed {
            reply: reply.to_owned(),
            call_id: s.call.id.clone(),
            name: s.name.to_owned(),
            verdict,
            reason,
            model: model.id().to_owned(),
            cost_micros: 0,
            bound: super::autonomy::binding(&s.classed.shown),
        });
        Ok(match self.record_unless_stopped(id, reply, &event)? {
            true => screened,
            false => Screened::Stopped,
        })
    }
}

/// One decision, as logged: what was decided and how sure, never what the call said.
#[derive(Serialize)]
struct Logged<'a> {
    at: i64,
    conversation: &'a str,
    call_id: &'a str,
    tool: &'a str,
    subject: &'static str,
    class: &'static str,
    confidence: f32,
    low_risk: f32,
    person: f32,
    decision: &'static str,
    model: &'a str,
}

/// The size at which the log rolls over to `decisions.1.jsonl`.
const MOST_BYTES: u64 = 1024 * 1024;

/// The classifier's decisions, one JSON line each in `<dir>/decisions.jsonl`, kept on this
/// machine for retraining. Bounded: past [`MOST_BYTES`] it becomes `decisions.1.jsonl`.
pub(crate) struct Decisions {
    dir: PathBuf,
    held: Mutex<()>,
    /// The form each settled call must launch in, by call key, taken once by its launch.
    forms: Mutex<HashMap<String, Hardening>>,
}

impl Decisions {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            held: Mutex::new(()),
            forms: Mutex::default(),
        }
    }

    fn mark(&self, key: &str, form: Hardening) {
        self.forms
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key.to_owned(), form);
    }

    fn take(&self, key: &str) -> Option<Hardening> {
        self.forms
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key)
    }

    fn append(&self, line: &Logged<'_>) {
        let _held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        let path = self.dir.join("decisions.jsonl");
        let written = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(&self.dir)?;
            if std::fs::metadata(&path).is_ok_and(|m| m.len() >= MOST_BYTES) {
                std::fs::rename(&path, self.dir.join("decisions.1.jsonl"))?;
            }
            let mut bytes = serde_json::to_vec(line).map_err(std::io::Error::other)?;
            bytes.push(b'\n');
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?
                .write_all(&bytes)
        })();
        if let Err(error) = written {
            tracing::warn!(%error, "a classifier decision was not logged");
        }
    }
}
