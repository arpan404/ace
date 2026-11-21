//! Outside A2A agents as the person's apps (ADR 0202 §5, A2A 1.0.1). The person adds one by its
//! address; Spade fetches its Agent Card from the spec's well-known path, checks any signature
//! against keys its publisher serves on the card's own origin and says whether it holds, and
//! offers each skill as a tool `<agent>__<skill>` whose every call goes to the person (it sends
//! the person's data to another party: `send_as_person`). What comes back is untrusted. Stop
//! cancels the task, and a cancel Spade couldn't confirm is listed on the agent.
//!
//! An agent is remote unless the person adds it as local (on their own machine or network): a
//! remote one's card, keys and endpoint are reached only at public addresses over https, checked
//! and pinned on every request (`client`), whatever its card names.
//!
//! The added agents are kept in Spade's settings (`a2a_agents`) with the card as fetched, so
//! starting Spade reaches no agent.

pub mod card;
pub mod client;
pub mod task;
pub mod tools;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use serde::Serialize;
use serde_json::{Value, json};
use spade_connect::Addresses;
use spade_store::Store;

use card::{Card, Signed};
use client::A2aClient;

const SETTING: &str = "a2a_agents";
/// The most agents the person may add.
const MOST_AGENTS: usize = 32;
/// The most unconfirmed cancels kept per agent.
const MOST_UNCONFIRMED: usize = 16;

/// One added agent, as the API and its tools show it.
#[derive(Debug, Clone, Serialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Where its card was fetched.
    pub address: String,
    /// The person added it as on their own machine or network: only then may it be reached at
    /// local or private addresses.
    pub local: bool,
    /// Its JSON-RPC interface.
    pub endpoint: String,
    /// Its card's signature held with its publisher's key.
    pub signed: bool,
    /// "Signed by its publisher's key", or "Not signed".
    pub signature: String,
    /// Why it reads as not signed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsigned_because: Option<String>,
    pub skills: Vec<SkillView>,
    /// Tasks Stop asked it to cancel that it never confirmed ended: they may still be running.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unconfirmed_stops: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillView {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The tool a bot calls it with.
    pub tool: String,
    /// What a call of it does, in Spade's terms: it goes to the person every call.
    pub effect: &'static str,
    pub json: bool,
}

fn view(id: &str, address: &str, local: bool, card: &Card, signed: &Signed) -> Agent {
    Agent {
        id: id.to_owned(),
        name: card.name.clone(),
        description: card.description.clone(),
        address: address.to_owned(),
        local,
        endpoint: card.endpoint.clone(),
        signed: matches!(signed, Signed::Verified { .. }),
        signature: signed.words().to_owned(),
        unsigned_because: match signed {
            Signed::No(why) => Some(why.clone()),
            Signed::Verified { .. } => None,
        },
        skills: card
            .skills
            .iter()
            .map(|skill| SkillView {
                id: skill.id.clone(),
                name: skill.name.clone(),
                description: skill.description.clone(),
                tool: format!("{id}{}{}", spade_connect::SEPARATOR, skill.id),
                effect: "send_as_person",
                json: skill.json,
            })
            .collect(),
        unconfirmed_stops: Vec::new(),
    }
}

/// An agent's id from its name: lower-case letters, digits and single dashes.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(32).collect();
    if out.is_empty() {
        "agent".to_owned()
    } else {
        out.trim_end_matches('-').to_owned()
    }
}

/// An added agent: its view, and its card as Spade reads it.
#[derive(Debug, Clone)]
pub struct Added {
    pub agent: Agent,
    pub card: Card,
}

/// Tasks whose cancel an agent never confirmed, by agent id: what the person is told may still be
/// running.
#[derive(Default)]
pub struct Unconfirmed(Mutex<HashMap<String, Vec<String>>>);

impl Unconfirmed {
    pub fn note(&self, agent: &str, task: &str) {
        let mut all = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let tasks = all.entry(agent.to_owned()).or_default();
        if !tasks.iter().any(|t| t == task) {
            tasks.push(task.to_owned());
        }
        if tasks.len() > MOST_UNCONFIRMED {
            tasks.remove(0);
        }
    }

    fn of(&self, agent: &str) -> Vec<String> {
        let all = self.0.lock().unwrap_or_else(|p| p.into_inner());
        all.get(agent).cloned().unwrap_or_default()
    }
}

/// The person's outside agents.
pub struct OutsideAgents {
    store: Store,
    client: A2aClient,
    added: RwLock<Vec<Added>>,
    unconfirmed: Arc<Unconfirmed>,
}

impl OutsideAgents {
    /// The agents added before, from Spade's settings; none is reached. Names are resolved with
    /// `addresses` when an agent is reached.
    pub fn open(store: Store, addresses: Addresses) -> Arc<Self> {
        let kept: Vec<Value> = store
            .setting(SETTING)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let added = kept
            .iter()
            .filter_map(|row| {
                let card = card::read(&row["card"]).ok()?;
                let signed = match row["signed"].as_str() {
                    Some(kid) => Signed::Verified {
                        kid: kid.to_owned(),
                    },
                    None => Signed::No(row["why"].as_str().unwrap_or_default().to_owned()),
                };
                let id = row["id"].as_str()?;
                let address = row["address"].as_str().unwrap_or_default();
                let local = row["local"].as_bool().unwrap_or(false);
                Some(Added {
                    agent: view(id, address, local, &card, &signed),
                    card,
                })
            })
            .collect();
        Arc::new(Self {
            store,
            client: A2aClient::new(addresses),
            added: RwLock::new(added),
            unconfirmed: Arc::default(),
        })
    }

    pub fn client(&self) -> &A2aClient {
        &self.client
    }

    /// Where a call's cancel that never confirmed is noted.
    pub fn unconfirmed(&self) -> Arc<Unconfirmed> {
        self.unconfirmed.clone()
    }

    pub fn list(&self) -> Vec<Added> {
        let mut added = self.added.read().unwrap_or_else(|p| p.into_inner()).clone();
        for one in &mut added {
            one.agent.unconfirmed_stops = self.unconfirmed.of(&one.agent.id);
        }
        added
    }

    /// Adds the agent at `address`, local (on the person's own machine or network) only when the
    /// person says so: its card fetched and read, its endpoint checked as the agent's every call
    /// will be, its signature checked. A card Spade can't call is refused with why; one whose
    /// signature doesn't hold is added, marked "Not signed".
    pub async fn add(&self, address: &str, local: bool) -> Result<Agent, String> {
        let at = client::card_address(address)?;
        let raw = self
            .client
            .document(&at, local)
            .await
            .map_err(|why| format!("Its card couldn't be read: {why}"))?;
        let card = card::read(&raw)?;
        self.client
            .check(&card.endpoint, local)
            .await
            .map_err(|why| format!("Its card names an endpoint Spade won't call: {why}"))?;
        let signed = card::verify(&raw, &self.key_sets(&at, &raw, local).await);
        let mut added = self.added.write().unwrap_or_else(|p| p.into_inner());
        if let Some(same) = added.iter().find(|a| a.agent.address == at.as_str()) {
            return Err(format!("{} is added already.", same.agent.name));
        }
        if added.len() >= MOST_AGENTS {
            return Err(format!("At most {MOST_AGENTS} agents can be added."));
        }
        let base = slug(&card.name);
        let mut id = base.clone();
        let mut n = 2;
        while added.iter().any(|a| a.agent.id == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        let agent = view(&id, at.as_str(), local, &card, &signed);
        let mut rows = self.rows();
        rows.push(json!({
            "id": id,
            "address": at.as_str(),
            "local": local,
            "card": raw,
            "signed": match &signed { Signed::Verified { kid } => Some(kid.clone()), Signed::No(_) => None },
            "why": match &signed { Signed::No(why) => Some(why.clone()), Signed::Verified { .. } => None },
        }));
        self.keep(&rows)?;
        added.push(Added {
            agent: agent.clone(),
            card,
        });
        Ok(agent)
    }

    /// Each signature's own key set, from the `jku` it names, which must be on the card's origin:
    /// one signature's keys are never another's.
    async fn key_sets(
        &self,
        at: &reqwest::Url,
        raw: &Value,
        local: bool,
    ) -> Vec<Result<Value, String>> {
        let mut fetched: Vec<(String, Result<Value, String>)> = Vec::new();
        let mut sets = Vec::new();
        for jku in card::key_set_addresses(raw) {
            let Some(jku) = jku else {
                sets.push(Err("its signature names no keys".to_owned()));
                continue;
            };
            let Some(jku) = client::same_origin(at, &jku) else {
                sets.push(Err(
                    "its signature names keys on another address than its card's".to_owned(),
                ));
                continue;
            };
            let keys = match fetched.iter().find(|(url, _)| url == jku.as_str()) {
                Some((_, keys)) => keys.clone(),
                None => {
                    let keys = self
                        .client
                        .document(&jku, local)
                        .await
                        .map_err(|why| format!("its publisher's keys couldn't be read: {why}"));
                    fetched.push((jku.to_string(), keys.clone()));
                    keys
                }
            };
            sets.push(keys);
        }
        sets
    }

    /// Removes agent `id`; whether it was there.
    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let mut added = self.added.write().unwrap_or_else(|p| p.into_inner());
        let before = added.len();
        let rows: Vec<Value> = self
            .rows()
            .into_iter()
            .filter(|row| row["id"] != id)
            .collect();
        if rows.len() == before {
            return Ok(false);
        }
        self.keep(&rows)?;
        added.retain(|a| a.agent.id != id);
        Ok(true)
    }

    fn rows(&self) -> Vec<Value> {
        self.store
            .setting(SETTING)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn keep(&self, rows: &[Value]) -> Result<(), String> {
        let text = serde_json::to_string(rows).map_err(|e| e.to_string())?;
        self.store
            .set_setting(SETTING, Some(&text))
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agents_id_is_a_slug_of_its_name() {
        for (name, want) in [
            ("Travel Desk", "travel-desk"),
            ("  Fares++ & Co ", "fares-co"),
            ("!!!", "agent"),
        ] {
            assert_eq!(slug(name), want, "{name}");
        }
    }
}
