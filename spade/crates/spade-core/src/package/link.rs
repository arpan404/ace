//! What a bot installed from a version 3 package keeps of it (ADR 0200 §3.9): the package it is
//! linked to, the manifest as installed now, the effect switches the person left on, what those
//! switches made, and the values the package last set, so an update can tell a field the person
//! or the bot changed (detached) from one the package still owns.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Manifest;
use crate::effect::ceiling::Effects;
use crate::personality::Personality;
use crate::routine::Trigger;

/// Which package, and which of its versions, by the market's signed manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageId {
    pub source: String,
    pub name: String,
    pub version: String,
    pub hash: String,
}

/// A routine as the package last set it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MadeRoutine {
    pub id: String,
    pub instruction: String,
    pub trigger: Trigger,
}

/// A note as the package last set it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MadeNote {
    pub id: String,
    pub text: String,
}

/// The values the package last set on the bot, as stored then.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Made {
    pub name: String,
    pub task: String,
    /// The face as stored after it was set (repaired by Spade's rules).
    #[serde(default)]
    pub face: Option<Value>,
    #[serde(default)]
    pub personality: Option<Personality>,
    /// By routine name.
    #[serde(default)]
    pub routines: BTreeMap<String, MadeRoutine>,
    #[serde(default)]
    pub notes: Vec<MadeNote>,
}

/// What one switch the person left on made, so turning it off takes back exactly that.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Granted {
    /// The grant its switch made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<String>,
    /// Hosts it added to the bot's egress allow list that weren't there before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
}

/// A withdrawn version's pause (ADR 0200 §6.1): its reason, and the routines it paused, which
/// resuming turns on again. Nothing is deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Withdrawn {
    pub reason: String,
    #[serde(default)]
    pub paused: Vec<String>,
}

/// An update or rollback under way (ADR 0200 §6.2): written before its first step, with each
/// routine and note it adds or removes as it goes, and cleared when it commits. A crash leaves
/// it, and the same step is taken again from the start; what it already did counts as done.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pending {
    pub transaction: String,
    pub package: PackageId,
    pub manifest: Manifest,
    /// Routines it added, by name.
    #[serde(default)]
    pub routines: BTreeMap<String, String>,
    #[serde(default)]
    pub notes_added: Vec<MadeNote>,
    #[serde(default)]
    pub notes_removed: Vec<MadeNote>,
}

/// The link, as stored under `package:<bot>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub package: PackageId,
    pub manifest: Manifest,
    /// The effect switches the person left on, by [`super::Declared::key`].
    pub on: BTreeSet<String>,
    #[serde(default)]
    pub granted: BTreeMap<String, Granted>,
    pub made: Made,
    /// The transaction that installed or last updated it: the same one asked again answers with
    /// what it did, and does nothing twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction: Option<String>,
    /// The version it had before the last update or rollback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<PackageId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawn: Option<Withdrawn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Pending>,
}

impl Link {
    /// The effects its package declared that the person left on: its ceiling.
    pub fn allows(&self) -> Effects {
        self.manifest
            .effects
            .iter()
            .filter(|declared| self.on.contains(&declared.key()))
            .map(|declared| declared.effect)
            .collect()
    }
}

/// The ceiling over a chain of bots from the top down: every packaged bot's allowance, narrowed
/// by every one above it; `None` when none of them is packaged.
pub fn narrowed(chain: impl IntoIterator<Item = Option<Effects>>) -> Option<Effects> {
    chain.into_iter().flatten().reduce(Effects::and)
}

/// The switches as the person left them on the review: a declared effect is on only where their
/// switch says so (a switch missing from the answer is off), and a key the package didn't
/// declare turns nothing on.
pub fn switched_on(manifest: &Manifest, switches: &BTreeMap<String, bool>) -> BTreeSet<String> {
    manifest
        .effect_keys()
        .into_iter()
        .filter(|key| switches.get(key).copied().unwrap_or(false))
        .collect()
}
