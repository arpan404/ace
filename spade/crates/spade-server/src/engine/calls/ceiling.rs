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

/// What the ceiling reads a call as, read before it starts: its declared effect, what a command
/// runs and where, and whether it reaches a server. Read without any lock (it may wait on a
/// command's files); checked against the ceiling as it is at the moment the call starts.
pub(super) struct Reading {
    declared: Option<effect::Effect>,
    command: Option<Class>,
    place: Place,
    remote: bool,
}

/// The call's [`Reading`], when a package's ceiling is over `id`; `Some(None)` when none is, and
/// `None` when Stop came while it was read.
pub(super) async fn read(
    engine: &Engine,
    id: &str,
    call_id: &str,
    name: &str,
    arguments: &Value,
    stop: &mut watch::Receiver<bool>,
) -> Option<Option<Reading>> {
    if engine.ceiling(id).is_none() {
        return Some(None);
    }
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
    Some(Some(Reading {
        declared,
        command: outside_class(&classed),
        place,
        remote,
    }))
}

/// Why the ceiling over `id`, as it is now, refuses a call read as `reading`, with `raised` (what
/// Spade's classifier read in it when it raised it to the person) held to it as well.
pub(super) fn refusal(
    engine: &Engine,
    id: &str,
    reading: &Reading,
    raised: Option<effect::Effect>,
) -> Option<String> {
    let (bot, allows) = engine.ceiling(id)?;
    let ceiling = Some(effect::ceiling::Ceiling { bot: &bot, allows });
    let declared = match (reading.declared, raised) {
        (Some(declared), Some(raised)) => Some(declared.max(raised)),
        (declared, None) => declared,
        (None, raised) => raised,
    };
    effect::ceiling_holds(
        ceiling,
        declared,
        reading.command,
        reading.place,
        reading.remote,
    )
}

/// Why the ceiling refuses a call the classifier raised to the person for `raised`, if it does:
/// a payment or send the package never declared is refused, never asked (ADR 0200 §3.4).
pub(super) fn raised_refusal(
    ceiling: Option<&(String, spade_core::effect::ceiling::Effects)>,
    raised: Option<effect::Effect>,
    place: Place,
    remote: bool,
) -> Option<String> {
    let (bot, allows) = ceiling?;
    effect::ceiling_holds(
        Some(effect::ceiling::Ceiling {
            bot,
            allows: *allows,
        }),
        Some(raised?),
        None,
        place,
        remote,
    )
}

/// Holds the package of every packaged bot whose ceiling is over `id`, so no switch of theirs
/// changes between the ceiling's last check and the call's start. Waited for off the async
/// workers; let go when dropped.
pub(super) async fn hold(engine: &Engine, id: &str) -> Vec<crate::packages::Busy> {
    let mut holders = engine.ceiling_holders(id);
    holders.sort();
    holders.dedup();
    let changing = engine.package_busy.clone();
    tokio::task::spawn_blocking(move || {
        holders
            .iter()
            .map(|bot| changing.hold(bot))
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default()
}
