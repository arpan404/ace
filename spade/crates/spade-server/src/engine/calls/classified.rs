//! Classifying a call (ADR 0144) off the turn's thread, bounded in time, and where the gate lets
//! the call it classified run.

use serde_json::Value;
use spade_core::autonomy::{self, Class, Runs, Sensitive};
use tokio::sync::watch;

use super::super::Engine;
use crate::workspace::shell::Launch;

/// The longest a call's classification may take (reading the scripts and makefiles it runs)
/// before it is given up ([`Engine::classify_time`]).
pub(crate) const CLASSIFY_TIME: std::time::Duration = std::time::Duration::from_secs(10);

/// What classifying a call came to.
pub(super) enum Classified {
    Done(autonomy::Classed),
    /// It ran out of time or failed: where the call may run without widening it (in the
    /// sandbox, or asking to run outside). Never enough to approve or start a call outside.
    Failed(autonomy::Classed),
}

impl Classified {
    pub(super) fn classed(self) -> autonomy::Classed {
        match self {
            Self::Done(classed) | Self::Failed(classed) => classed,
        }
    }
}

/// Why a call asking to run outside the sandbox isn't asked about: Spade couldn't read what it
/// would run there.
pub(super) const UNREAD_OUTSIDE: &str = "Spade couldn't read what this command would run, so it can't be \
     run outside the sandbox now.";

/// What a call reaches (ADR 0144), worked out off the turn's thread: reading a command's files is
/// blocking work, bounded by the classifier's budget and here by [`CLASSIFY_TIME`]. Stop is
/// heard meanwhile: `None` when it was pressed.
pub(super) async fn classify(
    engine: &Engine,
    id: &str,
    name: &str,
    key: &str,
    arguments: &Value,
    stop: &mut watch::Receiver<bool>,
) -> Option<Classified> {
    let Some(tool) = engine.tools.get_for(id, name) else {
        return Some(Classified::Done(
            Class::Sensitive(Sensitive::Unknown).into(),
        ));
    };
    // A classification that fails never widens where the call runs: one asking to leave the
    // sandbox goes to the person, anything else stays in it (and a launch held to the sandbox is
    // refused where there is none).
    let failed = if crate::workspace::asks_outside(arguments) {
        autonomy::Classed::asks_outside()
    } else {
        autonomy::Classed::sandboxed()
    };
    // No time for it at all: failed, as when it runs out.
    if engine.classify_time().is_zero() {
        return Some(Classified::Failed(failed));
    }
    let (key, arguments) = (key.to_owned(), arguments.clone());
    let work = tokio::task::spawn_blocking(move || tool.classed(&key, &arguments));
    tokio::select! {
        done = tokio::time::timeout(engine.classify_time(), work) => Some(match done {
            Ok(Ok(classed)) => Classified::Done(classed),
            // Took too long, or panicked.
            _ => Classified::Failed(failed),
        }),
        _ = stop.wait_for(|stopped| *stopped) => None,
    }
}

/// What the gate authorizes for a call that runs where `runs` says: outside the sandbox, or
/// contained only when it was decided in the sandbox's light (whether unreviewed because the
/// sandbox held it or reviewed as a sandboxed command), else reviewed to run as it is.
pub(super) fn launch_for(runs: Runs) -> Launch {
    match runs {
        Runs::Outside => Launch::Outside,
        Runs::Sandbox => Launch::Contained,
        Runs::Host | Runs::AsksOutside => Launch::Reviewed,
    }
}
