//! A package's effect switches as ADR 0167 state (ADR 0200 §3.4). Declaring an effect grants
//! nothing: only a switch the person leaves on becomes something, recorded `by: person`. A
//! `network` switch with hosts adds those hosts to the bot's egress allow list; a switch with a
//! grant makes that grant. Turning a switch off takes back exactly what it made, and nothing the
//! person added themselves. The link and what its switches made are committed together, in one
//! transaction: a link never says a switch is off while its grant is still in place, nor on
//! without it.

use std::collections::{BTreeMap, BTreeSet};

use spade_core::package::link::{Granted, Link};
use spade_core::package::{Declared, Manifest};
use spade_store::package_key;

use super::PackageError;
use crate::engine::Engine;
use crate::engine::packages::link_text;
use crate::security::{BotSecurity, MachineSecurity, Security, SecurityError};

/// Stores `link` for `bot` with its switches moved from `before` to `after`: the grants and hosts
/// they make or take back, and the link with `on` and `granted` as they then are, in one
/// transaction. On a failure nothing changed and `link` is as it was.
pub fn commit(
    engine: &Engine,
    bot: &str,
    link: &mut Link,
    before: &BTreeSet<String>,
    after: BTreeSet<String>,
) -> Result<(), PackageError> {
    let mut next = link.clone();
    next.on = after;
    match engine.security() {
        Some(security) => {
            let manifest = next.manifest.clone();
            let on = next.on.clone();
            // A run that reached a host or the network before a switch went off reaches it no
            // more, and no run is issued the old policy while this commits.
            security
                .narrowing(|| {
                    security.change_with(bot, |current, machine| {
                        let moved = Moving {
                            security,
                            bot,
                            manifest: &manifest,
                            machine,
                        };
                        moved
                            .apply(current, &mut next.granted, before, &on)
                            .map_err(SecurityError::Invalid)?;
                        Ok(vec![(package_key(bot), Some(link_text(&next)))])
                    })
                })
                .map_err(|error| PackageError::Invalid(error.to_string()))?;
        }
        None if !touches_security(&next.manifest, &next.granted, before, &next.on) => {
            engine
                .set_bot_package(bot, &next)
                .map_err(|e| PackageError::Failed(e.to_string()))?;
        }
        None => {
            return Err(PackageError::Invalid(
                "Spade's security isn't ready, so nothing can be allowed".to_owned(),
            ));
        }
    }
    *link = next;
    Ok(())
}

/// Whether moving from `before` to `after` makes or takes back anything Spade's security keeps.
fn touches_security(
    manifest: &Manifest,
    granted: &BTreeMap<String, Granted>,
    before: &BTreeSet<String>,
    after: &BTreeSet<String>,
) -> bool {
    before
        .difference(after)
        .any(|key| granted.contains_key(key))
        || after.difference(before).any(|key| {
            manifest
                .effects
                .iter()
                .any(|d| d.key() == *key && (d.grant.is_some() || !d.hosts.is_empty()))
        })
}

/// One move of a bot's switches, on its settings as they are about to be stored.
struct Moving<'a> {
    security: &'a Security,
    bot: &'a str,
    manifest: &'a Manifest,
    machine: &'a MachineSecurity,
}

impl Moving<'_> {
    fn apply(
        &self,
        current: &mut BotSecurity,
        granted: &mut BTreeMap<String, Granted>,
        before: &BTreeSet<String>,
        after: &BTreeSet<String>,
    ) -> Result<(), String> {
        for key in before.difference(after) {
            if let Some(made) = granted.remove(key) {
                self.take_back(current, &made);
            }
        }
        for key in after.difference(before) {
            let Some(declared) = self.manifest.effects.iter().find(|d| d.key() == *key) else {
                continue;
            };
            let made = self.make(current, declared)?;
            if made != Granted::default() {
                granted.insert(key.clone(), made);
            }
        }
        Ok(())
    }

    fn make(&self, current: &mut BotSecurity, declared: &Declared) -> Result<Granted, String> {
        let mut made = Granted::default();
        if let Some(scope) = &declared.grant {
            let grant = self
                .security
                .admit_grant(self.bot, scope.clone(), "person")
                .map_err(|e| e.to_string())?;
            // One the person already has stays theirs: this switch made nothing to take back.
            if !current.grants.iter().any(|g| g.scope == grant.scope) {
                made.grant = Some(grant.id.clone());
                current.grants.push(grant);
            }
        }
        if !declared.hosts.is_empty() {
            let mut policy = self.network(current);
            let added: Vec<String> = declared
                .hosts
                .iter()
                .filter(|host| !policy.allow.contains(host))
                .cloned()
                .collect();
            if !added.is_empty() {
                policy.allow.extend(added.iter().cloned());
                current.network = Some(policy);
                made.hosts = added;
            }
        }
        Ok(made)
    }

    fn take_back(&self, current: &mut BotSecurity, made: &Granted) {
        if let Some(id) = &made.grant {
            current.grants.retain(|g| g.id != *id);
        }
        if !made.hosts.is_empty() {
            let mut policy = self.network(current);
            policy.allow.retain(|host| !made.hosts.contains(host));
            current.network = Some(policy);
        }
    }

    /// The bot's commands' network policy as it holds now: its own, or the machine's.
    fn network(&self, current: &BotSecurity) -> spade_sandbox::egress::NetworkPolicy {
        current
            .network
            .clone()
            .unwrap_or_else(|| self.machine.network.clone())
    }
}
