//! A packaged bot's ceiling (ADR 0200 §3.4) on a call's way through: what the gate reads a
//! command as, the modules its package uses, and the ceiling read again right before a call
//! starts. A call decided, asked about or queued while a switch was on (approved by the person,
//! held on a Reconnect card, waiting its turn) never starts after the person turned it off.

use serde_json::Value;
use spade_core::autonomy::{Class, Classed, Runs, Sensitive};
use spade_core::effect::{self, Place};
use tokio::sync::watch;

use super::super::Engine;
use super::{Classified, classify};

/// What the shell classifier read in a command that runs, or asks to run, outside the sandbox:
/// what the ceiling holds it to. A sandboxed command's reach is the sandbox's, held at its egress.
pub(super) fn outside_class(classed: &Classed) -> Option<Class> {
    matches!(classed.runs, Runs::Outside | Runs::AsksOutside).then_some(classed.class)
}

/// What a bot is told about a tool its package's `uses` leaves out.
pub(super) fn not_used(name: &str) -> String {
    format!(
        "There is no tool named {name}: this bot's package doesn't use the module it belongs to."
    )
}

/// Why the call may not start now under the ceiling over `id` as it is now; `Some(None)` when it
/// may, and `None` when Stop came while it was read.
pub(super) async fn refused_now(
    engine: &Engine,
    id: &str,
    call_id: &str,
    name: &str,
    arguments: &Value,
    stop: &mut watch::Receiver<bool>,
) -> Option<Option<String>> {
    let Some((bot, allows)) = engine.ceiling(id) else {
        return Some(None);
    };
    let tool = engine.tools.get_for(id, name);
    let (declared, classed) = match &tool {
        Some(tool) => {
            let key = format!("{id}.{call_id}");
            let classed = match classify(engine, id, name, &key, arguments, stop).await? {
                Classified::Done(classed) => classed,
                // Not read now: what it would run outside the sandbox is unresolved.
                Classified::Failed(classed) => Classed {
                    class: Class::Sensitive(Sensitive::Unclear),
                    ..classed
                },
            };
            (tool.effect(arguments), classed)
        }
        // Spade's own `tool_search`, answered from the registry: the gate's table says.
        None => (effect::table(name), Classed::default()),
    };
    let remote = tool
        .as_ref()
        .is_some_and(|tool| tool.hints().is_some() && !tool.sealed());
    let place = match classed.runs {
        Runs::Sandbox => Place::Sandbox,
        Runs::Host => Place::Host,
        Runs::AsksOutside => Place::AsksOutside,
        Runs::Outside => Place::Unsandboxed(classed.class),
    };
    let ceiling = effect::ceiling::Ceiling { bot: &bot, allows };
    Some(effect::ceiling_holds(
        Some(ceiling),
        declared,
        outside_class(&classed),
        place,
        remote,
    ))
}
