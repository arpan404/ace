// SPDX-License-Identifier: Apache-2.0
//! `creation-admissions.ts` (E5.4e): the reservation that spans asynchronous preparation and
//! the synchronous receipt. A JS owner object becomes a token (E5.1's three-way owner).

use ace_json::Value;

/// What an admission asks the engine for.
pub trait CreationStore {
    fn thread_exists(&self, id: &str) -> bool;
    fn reserve(&mut self, id: &str) -> bool;
    fn release(&mut self, id: &str);
}

#[derive(Debug, Clone)]
struct Held {
    owner: u64,
    command: String,
}

/// A held reservation: its normalized command and the token that owns it.
#[derive(Debug, Clone)]
pub struct Admission {
    pub id: String,
    pub command: Value,
    pub owner: u64,
}

/// The engine's side of a reservation: the thread row, the slot, and its release. A receipt
/// splits `State` so the reservation and the repository are borrowed apart.
pub struct RepoStore<'a> {
    pub repo: &'a mut crate::repository::Repo,
    pub store: &'a crate::EngineStore,
}

impl CreationStore for RepoStore<'_> {
    fn thread_exists(&self, id: &str) -> bool {
        self.store.get_thread(id).ok().flatten().is_some()
    }

    fn reserve(&mut self, id: &str) -> bool {
        self.repo.reserve(self.store, id).unwrap_or(false)
    }

    fn release(&mut self, id: &str) {
        let _ = self.repo.release_slot(self.store, id);
    }
}

/// `CreationAdmissions`: one reservation per thread id.
#[derive(Debug, Default)]
pub struct CreationAdmissions {
    owners: std::collections::HashMap<String, Held>,
    next_owner: u64,
}

/// The id a create or prepare asks for: its own, or the next one.
fn payload_id(command: &Value, next_id: &str) -> Option<String> {
    let payload = command.get("payload")?;
    Some(
        payload
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| next_id.to_owned()),
    )
}

impl CreationAdmissions {
    /// `acquire`: `Err(code)` refuses, `Ok` holds the id and reserves its slot.
    pub fn acquire(
        &mut self,
        store: &mut dyn CreationStore,
        command: &Value,
        next_id: &str,
    ) -> Result<Admission, String> {
        let Some(payload) = command.get("payload") else {
            return Err("invalid_command".to_owned());
        };
        if !matches!(
            payload.get("type").and_then(Value::as_str),
            Some("thread.create") | Some("thread.prepare")
        ) {
            return Err("invalid_command".to_owned());
        }
        let Some(id) = payload_id(command, next_id) else {
            return Err("invalid_command".to_owned());
        };
        if self.owners.contains_key(&id) {
            return Err("thread_creation_in_progress".to_owned());
        }
        if store.thread_exists(&id) {
            return Err("thread_exists".to_owned());
        }
        if !store.reserve(&id) {
            return Err("engine_capacity_exceeded".to_owned());
        }
        let mut normalized = command.clone();
        if let Some(map) = normalized.get_mut("payload").and_then(Value::as_object_mut) {
            map.insert("threadId", Value::from(id.as_str()));
        }
        let token = self.next_owner + 1;
        self.next_owner = token;
        self.owners.insert(
            id.clone(),
            Held {
                owner: token,
                command: ace_json::to_string(&normalized),
            },
        );
        Ok(Admission {
            id,
            command: normalized,
            owner: token,
        })
    }

    /// `release`: frees the id and, when no thread took it, its slot.
    pub fn release(&mut self, store: &mut dyn CreationStore, admission: &Admission) {
        let Some(held) = self.owners.get(&admission.id) else {
            return;
        };
        if held.owner != admission.owner {
            return;
        }
        self.owners.remove(&admission.id);
        if !store.thread_exists(&admission.id) {
            store.release(&admission.id);
        }
    }

    /// `pending`: whether the id is held.
    pub fn pending(&self, id: &str) -> bool {
        self.owners.contains_key(id)
    }

    /// `authorized`: the receipt accepts its own reservation, or no owner when nothing holds it.
    pub fn authorized(&self, command: &Value, owner: Option<u64>) -> bool {
        let Some(payload) = command.get("payload") else {
            return false;
        };
        if !matches!(
            payload.get("type").and_then(Value::as_str),
            Some("thread.create") | Some("thread.prepare")
        ) {
            return false;
        }
        let id = payload.get("threadId").and_then(Value::as_str);
        match id.and_then(|id| self.owners.get(id)) {
            Some(held) => Some(held.owner) == owner && held.command == ace_json::to_string(command),
            None => owner.is_none(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Store {
        exists: bool,
        reserved: bool,
        released: usize,
    }

    impl CreationStore for Store {
        fn thread_exists(&self, _id: &str) -> bool {
            self.exists
        }
        fn reserve(&mut self, _id: &str) -> bool {
            self.reserved = true;
            true
        }
        fn release(&mut self, _id: &str) {
            self.released += 1;
            self.reserved = false;
        }
    }

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    fn command(id: Option<&str>) -> Value {
        value(&format!(
            r#"{{"id":"c","deviceId":"d","payload":{{"type":"thread.create","workspaceId":"w","provider":"codex","input":[]{} }} }}"#,
            id.map_or(String::new(), |id| format!(r#","threadId":"{id}""#))
        ))
    }

    #[test]
    fn an_absent_owner_is_accepted_only_without_a_reservation() {
        let mut admissions = CreationAdmissions::default();
        let mut store = Store::default();
        assert!(admissions.authorized(&command(Some("t")), None));
        let held = admissions
            .acquire(&mut store, &command(None), "next-id")
            .expect("acquired");
        assert_eq!(held.id, "next-id");
        assert!(!admissions.authorized(&command(Some("next-id")), None));
        assert!(admissions.authorized(&held.command, Some(held.owner)));
        // Another owner's token never authorizes.
        assert!(!admissions.authorized(&held.command, Some(held.owner + 1)));
        // The same id with a different command is not the held one.
        let changed = value(
            r#"{"id":"c","deviceId":"d","payload":{"type":"thread.create","workspaceId":"w","provider":"codex","threadId":"next-id","input":[{"type":"text","text":"x"}]}}"#,
        );
        assert!(!admissions.authorized(&changed, Some(held.owner)));
    }

    #[test]
    fn a_released_id_frees_its_slot_once_and_only_its_own_owner() {
        let mut admissions = CreationAdmissions::default();
        let mut store = Store::default();
        let held = admissions
            .acquire(&mut store, &command(Some("t")), "unused")
            .expect("acquired");
        assert!(admissions.pending("t"));
        let mut foreign = held.clone();
        foreign.owner = held.owner + 1;
        admissions.release(&mut store, &foreign);
        assert!(admissions.pending("t"), "a foreign owner changes nothing");
        admissions.release(&mut store, &held);
        assert!(!admissions.pending("t"));
        assert_eq!(store.released, 1);
        admissions.release(&mut store, &held);
        assert_eq!(store.released, 1, "a second release frees nothing");
    }

    #[test]
    fn a_held_id_or_a_taken_thread_is_refused() {
        let mut admissions = CreationAdmissions::default();
        let mut store = Store::default();
        admissions
            .acquire(&mut store, &command(Some("t")), "unused")
            .expect("acquired");
        assert_eq!(
            admissions
                .acquire(&mut store, &command(Some("t")), "unused")
                .unwrap_err(),
            "thread_creation_in_progress"
        );
        store.exists = true;
        assert_eq!(
            admissions
                .acquire(&mut store, &command(Some("other")), "unused")
                .unwrap_err(),
            "thread_exists"
        );
    }
}
