//! Spade's own tool-call classifier (ADR 0172): a small linear model over hashed features of a
//! shell command or a tool call, int8, built into the binary. It sits between Spade's
//! deterministic gate and the reviewer model, and is never the security boundary: the sandbox,
//! declared effects, the credential refusal and the person-only effects are decided before it.
//! It can do two things, each only above a calibrated threshold, and otherwise abstains:
//!
//! - **raise** a call to the person, when it reads one of the person-only effects;
//! - **settle** a call as low-risk (`read`, or `write_local` in the bot's folders), only where the
//!   gate allows it ([`Reviewing::may_settle`]).
//!
//! Pure and deterministic: the same input gives the same output, with no I/O and no network.

mod ambient;
mod harden;
mod hash;
mod math;
mod model;
mod shape;
mod shell;
mod text;
mod tool;

use std::borrow::Cow;
use std::sync::OnceLock;

use serde_json::Value;
pub use spade_core::autonomy::ConfigTools;
pub use spade_core::effect::{Effect, Mcp};

pub use ambient::{Files, Found as FileRead, inspect};
pub use harden::{Hardening, hardening, names as hardening_names};
pub use hash::{BUCKETS, KNOWN_BITS, probes};
pub use math::exp;
pub use model::{Header, Invalid, Model, encode, known_bits, quantize, softmax};

/// The effects the model tells apart, in the order of its outputs. `unknown` is a declaration's
/// word, never something a call is read as.
pub const CLASSES: [Effect; 9] = [
    Effect::Read,
    Effect::WriteLocal,
    Effect::Network,
    Effect::Publish,
    Effect::SendAsPerson,
    Effect::Pay,
    Effect::Drive,
    Effect::ChangeAccess,
    Effect::Credential,
];

/// The effects only the person may decide (ADR 0171): the model may raise a call for these.
pub const PERSON_ONLY: [Effect; 5] = [
    Effect::SendAsPerson,
    Effect::Pay,
    Effect::Drive,
    Effect::ChangeAccess,
    Effect::Credential,
];

/// The effects that are low-risk when the gate lets the model settle a call.
pub const LOW_RISK: [Effect; 2] = [Effect::Read, Effect::WriteLocal];

/// The class index of an effect, when the model has one for it.
pub fn class_of(effect: Effect) -> Option<usize> {
    CLASSES.iter().position(|e| *e == effect)
}

/// What is classified.
#[derive(Debug, Clone, Copy)]
pub enum Subject<'a> {
    /// A shell command, run from the bot's folder `workspace` when known.
    Shell {
        command: &'a str,
        workspace: Option<&'a str>,
    },
    /// A tool call, with the hints and trusted declaration its server came with.
    Tool {
        name: &'a str,
        arguments: &'a Value,
        hints: Mcp,
    },
}

/// A call's features: a sparse vector over [`BUCKETS`] rows.
#[derive(Debug, Clone, PartialEq)]
pub struct Features {
    pub vector: Vec<(u32, f32)>,
    /// An argument may point outside the bot's folders (the home folder, an absolute path, a
    /// climb out with `..`, a variable): never settled as low-risk.
    pub reaches_outside: bool,
    /// It hides what it runs (decoded text run as code, `eval`, escapes, look-alike letters,
    /// text that can't be read): never settled as low-risk, whatever the model reads.
    pub hides: bool,
    /// Full hashes of the programs, subcommands and flags the command is made of.
    pub keys: Vec<u64>,
    /// Structural input was past a feature bound, so part of it was not examined: never settled.
    pub dropped: bool,
    /// It may reach another machine: never settled while untrusted content is in view.
    pub network: bool,
    /// The tools it runs whose configuration could name a program for them to run.
    pub config: ConfigTools,
    /// It has a form that ignores configuration that could run a program ([`hardening`]): a
    /// command without one is never settled. Always true for a tool call, which never settles.
    pub hardened: bool,
}

pub fn features(subject: &Subject<'_>) -> Features {
    let mut bag = hash::Bag::default();
    let found = match *subject {
        Subject::Shell { command, workspace } => shell::features(command, workspace, &mut bag),
        Subject::Tool {
            name,
            arguments,
            hints,
        } => tool::features(name, arguments, hints, &mut bag),
    };
    let (vector, keys) = bag.finish();
    Features {
        vector,
        reaches_outside: found.outside,
        hides: found.hides,
        keys,
        dropped: found.dropped,
        network: found.network,
        config: found.config,
        hardened: match *subject {
            Subject::Shell { command, .. } => hardening(command).is_some(),
            Subject::Tool { .. } => true,
        },
    }
}

/// The model's reading of a call.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Prediction {
    /// Calibrated, in the order of [`CLASSES`]; they add up to 1.
    pub probabilities: [f32; CLASSES.len()],
    pub reaches_outside: bool,
    pub hides: bool,
    /// Every program, subcommand and flag in it appeared in a low-risk training command.
    pub known: bool,
    /// Part of the input was past a feature bound and not examined.
    pub dropped: bool,
    /// It may reach another machine.
    pub network: bool,
    /// The tools it runs whose configuration could name a program for them to run.
    pub config: ConfigTools,
    /// It has a form that ignores configuration that could run a program.
    pub hardened: bool,
}

impl Prediction {
    /// Whether nothing about the call itself rules out settling it: it points nowhere outside
    /// the bot's folders, hides nothing, and is made only of parts the model knows as low-risk
    /// (`npm install` is known; `npm install -g`, a flag never seen in a low-risk command, isn't).
    pub fn plain(&self) -> bool {
        !self.reaches_outside && !self.hides && self.known && !self.dropped && self.hardened
    }

    /// The most likely effect and its probability.
    pub fn top(&self) -> (Effect, f32) {
        let mut best = 0;
        for (i, p) in self.probabilities.iter().enumerate() {
            if *p > self.probabilities[best] {
                best = i;
            }
        }
        (CLASSES[best], self.probabilities[best])
    }

    pub fn of(&self, effect: Effect) -> f32 {
        class_of(effect).map_or(0.0, |i| self.probabilities[i])
    }

    /// The probability that it is low-risk (`read` or `write_local`).
    pub fn low_risk(&self) -> f32 {
        LOW_RISK.iter().map(|e| self.of(*e)).sum()
    }

    /// The most likely person-only effect, and the probability that it is any of them: the
    /// person decides whichever one it is, so a call read as half a send and half a payment is
    /// still theirs.
    pub fn person_only(&self) -> (Effect, f32) {
        let mut best = (PERSON_ONLY[0], self.of(PERSON_ONLY[0]));
        for effect in PERSON_ONLY {
            let p = self.of(effect);
            if p > best.1 {
                best = (effect, p);
            }
        }
        (best.0, PERSON_ONLY.iter().map(|e| self.of(*e)).sum())
    }
}

/// What the model decides about a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    /// Clearly low-risk: it runs without the reviewer.
    LowRisk,
    /// It reads as a person-only effect: the person decides.
    Person(Effect),
    /// Not sure enough: the reviewer decides, as without the model.
    Abstain,
}

impl Model {
    /// The model built into this binary; `None` if its file can't be read, and then the
    /// classifier abstains on everything.
    pub fn embedded() -> Option<&'static Self> {
        static EMBEDDED: OnceLock<Option<Model>> = OnceLock::new();
        EMBEDDED
            .get_or_init(|| {
                Model::parse(Cow::Borrowed(include_bytes!("../model/weights.bin"))).ok()
            })
            .as_ref()
    }

    pub fn predict(&self, subject: &Subject<'_>) -> Prediction {
        self.predict_features(&features(subject))
    }

    pub fn predict_features(&self, features: &Features) -> Prediction {
        Prediction {
            probabilities: self.probabilities(&features.vector),
            reaches_outside: features.reaches_outside,
            hides: features.hides,
            dropped: features.dropped,
            known: self.knows(&features.keys),
            network: features.network,
            config: features.config,
            hardened: features.hardened,
        }
    }

    /// For a call the gate may only raise: the person, or abstain.
    pub fn raise(&self, prediction: &Prediction) -> Screen {
        let (effect, p) = prediction.person_only();
        if p >= self.header().person {
            Screen::Person(effect)
        } else {
            Screen::Abstain
        }
    }

    /// For a call the gate lets the model settle: the person first, then low-risk when it is
    /// clearly so and nothing it names points outside the bot's folders, else abstain.
    pub fn screen(&self, prediction: &Prediction) -> Screen {
        match self.raise(prediction) {
            Screen::Abstain if prediction.plain() && prediction.low_risk() >= self.header().low => {
                Screen::LowRisk
            }
            raised => raised,
        }
    }

    /// For a plain command with untrusted content in view: the person first, then low-risk only
    /// when it is clearly low-risk, clearly only reads (its read probability alone over its own
    /// threshold, above every validation call that isn't a read) and can reach no other machine,
    /// so nothing it was shown can be sent anywhere or change anything.
    pub fn screen_read(&self, prediction: &Prediction) -> Screen {
        match self.raise(prediction) {
            Screen::Abstain
                if prediction.plain()
                    && !prediction.network
                    && prediction.low_risk() >= self.header().low
                    && prediction.of(Effect::Read) >= self.header().read =>
            {
                Screen::LowRisk
            }
            raised => raised,
        }
    }

    /// The decision for a call the gate sent to review: it may settle only a shell command the
    /// gate lets it settle (a plain one, and with untrusted content in view only a read that
    /// reaches nothing); anything else it can only raise to the person or leave to the reviewer.
    /// A command that doesn't start in a known bot's folder is never settled: its paths can't be
    /// placed against it.
    ///
    /// `config_clean` is the tools whose configuration around the command's folder the gate
    /// inspected ([`inspect`]) and found naming no program to run. A settled command comes with
    /// the [`Hardening`] it must run in; the gate records it and the launch applies it.
    pub fn decide(
        &self,
        subject: &Subject<'_>,
        reviewing: Reviewing,
        config_clean: ConfigTools,
    ) -> Decision {
        let prediction = self.predict(subject);
        let command = match subject {
            Subject::Shell {
                command,
                workspace: Some(_),
            } => Some(*command),
            _ => None,
        };
        // A tool whose configuration could run a program settles only where the gate found its
        // configuration runs nothing (ADR 0172, amendment 2), and only in its hard form
        // (amendment 3).
        let form = command
            .filter(|_| prediction.config.within(config_clean))
            .and_then(hardening);
        let screen = if form.is_some() && reviewing.may_settle() {
            self.screen(&prediction)
        } else if form.is_some() && reviewing.may_settle_read() {
            self.screen_read(&prediction)
        } else {
            self.raise(&prediction)
        };
        Decision {
            prediction,
            screen,
            hardening: form.filter(|_| screen == Screen::LowRisk),
        }
    }
}

/// What [`Model::decide`] came to.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub prediction: Prediction,
    pub screen: Screen,
    /// For a settled command, the form it must run in.
    pub hardening: Option<Hardening>,
}

/// What the gate knows about a call it sent to the reviewer, for whether the model may settle it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Reviewing {
    /// A shell command with no sandbox in which the shell classifier found nothing.
    pub plain_command: bool,
    /// Untrusted content is in view.
    pub tainted: bool,
    /// It runs files the reviewer would be shown (a script, a makefile, a package script).
    pub runs_files: bool,
    /// It sets up standing work.
    pub standing: bool,
    /// The rules named a concern for the reviewer.
    pub concern: bool,
}

impl Reviewing {
    /// Whether the model may settle the call as low-risk. Only a plain command the rules found
    /// nothing in, with nothing untrusted in view, no files it runs, no standing work and no
    /// concern: anything the rules singled out keeps its review, so the model never lowers a
    /// deterministic decision.
    pub fn may_settle(self) -> bool {
        self.plain_command && !self.tainted && !self.runs_files && !self.standing && !self.concern
    }

    /// Whether the model may settle the call as a read only ([`Model::screen_read`]): the same,
    /// except that untrusted content may be in view. A plain read in the bot's folder that can
    /// reach no other machine neither sends nor changes anything; what it shows joins content
    /// that is already untrusted.
    pub fn may_settle_read(self) -> bool {
        self.plain_command && !self.runs_files && !self.standing && !self.concern
    }
}
