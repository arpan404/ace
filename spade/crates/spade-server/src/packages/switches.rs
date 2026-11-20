//! A package's effect switches as ADR 0167 state (ADR 0200 §3.4). Declaring an effect grants
//! nothing: only a switch the person leaves on becomes something, recorded `by: person`. A
//! `network` switch with hosts adds those hosts to the bot's egress allow list; a switch with a
//! grant makes that grant. Turning a switch off takes back exactly what it made, and nothing the
//! person added themselves.

use std::collections::{BTreeMap, BTreeSet};

use spade_core::package::link::Granted;
use spade_core::package::{Declared, Manifest};

use crate::security::{Network, Security};

/// Moves the switches of `bot` from `before` to `after`, keeping what each made in `granted`.
/// Each step is recorded as it is taken, so a failure part-way leaves `granted` saying what is
/// in place for [`take_back_all`] to undo.
pub fn apply(
    security: Option<&Security>,
    bot: &str,
    manifest: &Manifest,
    granted: &mut BTreeMap<String, Granted>,
    before: &BTreeSet<String>,
    after: &BTreeSet<String>,
) -> Result<(), String> {
    for key in before.difference(after) {
        if let Some(made) = granted.remove(key) {
            take_back(security, bot, &made)?;
        }
    }
    for key in after.difference(before) {
        let Some(declared) = manifest.effects.iter().find(|d| d.key() == *key) else {
            continue;
        };
        let made = make(security, bot, declared)?;
        if made != Granted::default() {
            granted.insert(key.clone(), made);
        }
    }
    Ok(())
}

/// Takes back everything the switches made: a bot whose install failed, or one deleted.
pub fn take_back_all(security: Option<&Security>, bot: &str, granted: &BTreeMap<String, Granted>) {
    for made in granted.values() {
        if let Err(error) = take_back(security, bot, made) {
            tracing::warn!(%error, "a package switch's grant was not taken back");
        }
    }
}

fn ready(security: Option<&Security>) -> Result<&Security, String> {
    security.ok_or_else(|| "Spade's security isn't ready, so nothing can be allowed".to_owned())
}

fn make(security: Option<&Security>, bot: &str, declared: &Declared) -> Result<Granted, String> {
    let mut made = Granted::default();
    if let Some(scope) = &declared.grant {
        let grant = ready(security)?
            .add_grant(bot, scope.clone(), "person")
            .map_err(|e| e.to_string())?;
        made.grant = Some(grant.id);
    }
    if !declared.hosts.is_empty() {
        let security = ready(security)?;
        let mut policy = security.effective(bot).network;
        let added: Vec<String> = declared
            .hosts
            .iter()
            .filter(|host| !policy.allow.contains(host))
            .cloned()
            .collect();
        if !added.is_empty() {
            policy.allow.extend(added.iter().cloned());
            security
                .set_network(bot, Network::Commands, policy)
                .map_err(|e| e.to_string())?;
            made.hosts = added;
        }
    }
    Ok(made)
}

fn take_back(security: Option<&Security>, bot: &str, made: &Granted) -> Result<(), String> {
    let security = ready(security)?;
    if let Some(id) = &made.grant {
        security.remove_grant(bot, id).map_err(|e| e.to_string())?;
    }
    if !made.hosts.is_empty() {
        let mut policy = security.effective(bot).network;
        policy.allow.retain(|host| !made.hosts.contains(host));
        security
            .set_network(bot, Network::Commands, policy)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
