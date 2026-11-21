//! What a bot's package link changing records in the host's audit log (ADR 0206 §4.1): an
//! install finishing, an update, a rollback, a pause, its removal, or its effect switches
//! changed. Pure: given the link before and after one write, the entries to write with it.

use crate::package::link::{Link, PackageId};

use super::audit::{Entry, Ref};

/// Who a step is recorded as: the member whose stamp asked for it, the organization's policy, or
/// the host itself (a step it took on its own, such as an update held for the bot's still
/// moment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    Member(super::Member),
    Policy,
    Host(String),
}

impl Actor {
    pub fn reference(&self) -> Ref {
        match self {
            Self::Member(member) => {
                let actor = Ref::new("member", &member.account);
                match &member.name {
                    Some(name) => actor.named(name),
                    None => actor,
                }
            }
            Self::Policy => Ref::new("policy", "policy"),
            Self::Host(host) => Ref::new("host", host),
        }
    }
}

/// The bot a step names, and when it happened.
pub struct Stepped<'a> {
    pub bot: &'a str,
    pub name: &'a str,
    pub actor: &'a Actor,
    pub at: i64,
}

fn entry(action: &str, step: &Stepped<'_>, package: &PackageId) -> Entry {
    let mut entry = Entry::new(
        action,
        step.at,
        step.actor.reference(),
        vec![
            Ref::new("bot", step.bot).named(step.name),
            Ref::new("entry", &package.name),
        ],
    )
    .with("source", package.source.as_str())
    .with("name", package.name.as_str())
    .with("version", package.version.as_str())
    .with("hash", package.hash.as_str());
    if let Actor::Member(member) = step.actor {
        entry = entry.with("role", member.role.as_str());
    }
    entry
}

fn on(link: &Link) -> String {
    link.on.iter().cloned().collect::<Vec<_>>().join(",")
}

/// The entries one write of a bot's link records, from what it was (`before`) to what it is
/// (`after`; `None` once removed). An install records itself once it finishes, never while it
/// is still being made; an update under way records itself once it lands.
pub fn link_entries(before: Option<&Link>, after: Option<&Link>, step: &Stepped<'_>) -> Vec<Entry> {
    let Some(after) = after else {
        // Removed: only a link that was ever installed was a package here.
        return before
            .filter(|before| !before.installing)
            .map(|before| vec![entry("package.removed", step, &before.package)])
            .unwrap_or_default();
    };
    if after.installing || after.pending.is_some() {
        return Vec::new();
    }
    let Some(before) = before.filter(|before| !before.installing) else {
        return vec![
            entry("package.installed", step, &after.package).with("effects_on", on(after)),
        ];
    };
    let mut entries = Vec::new();
    if before.package.hash != after.package.hash || before.package.version != after.package.version
    {
        let back = before
            .previous
            .as_ref()
            .is_some_and(|previous| previous.hash == after.package.hash);
        let action = if back {
            "package.rolled_back"
        } else {
            "package.updated"
        };
        entries.push(
            entry(action, step, &after.package)
                .with("from_version", before.package.version.as_str())
                .with("effects_on", on(after)),
        );
    } else if before.on != after.on {
        // The same version, its switches changed: the bot's configuration.
        let mut configured = entry("bot.configured", step, &after.package)
            .with("changed", "effects")
            .with("effects_on", on(after));
        configured.targets.truncate(1);
        entries.push(configured);
    }
    if before.withdrawn.is_none()
        && let Some(withdrawn) = &after.withdrawn
    {
        entries.push(
            entry("package.paused", step, &after.package).with("reason", withdrawn.reason.as_str()),
        );
    }
    entries
}

#[cfg(test)]
mod tests;
