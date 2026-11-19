//! Stable integer ids per app. An element keeps its id for as long as it exists and shows the
//! same thing, so the model can act on ids from an earlier look and diffs stay small. List rows
//! may be recycled for other content: when a known element comes back with a different
//! fingerprint it gets a new id and the old one stops resolving. Pure and generic over the key
//! (a UI Automation runtime id) and the value (the live element).
use std::collections::HashMap;
use std::hash::Hash;

pub struct Ids<K: Clone + Eq + Hash, V: Clone> {
    ids: HashMap<K, u64>,
    entries: HashMap<u64, Entry<K, V>>,
    next: u64,
    generation: u64,
}

struct Entry<K, V> {
    key: K,
    value: V,
    fingerprint: Option<String>,
    seen: u64,
}

impl<K: Clone + Eq + Hash, V: Clone> Default for Ids<K, V> {
    fn default() -> Self {
        Self {
            ids: HashMap::new(),
            entries: HashMap::new(),
            next: 1,
            generation: 0,
        }
    }
}

impl<K: Clone + Eq + Hash, V: Clone> Ids<K, V> {
    pub fn begin_walk(&mut self) {
        self.generation += 1;
    }

    pub fn id(&mut self, key: &K, value: V, fingerprint: Option<String>) -> u64 {
        if let Some(&id) = self.ids.get(key) {
            let entry = self.entries.get_mut(&id);
            let same = entry.as_ref().is_some_and(|entry| {
                fingerprint.is_none()
                    || entry.fingerprint.is_none()
                    || entry.fingerprint == fingerprint
            });
            if let (true, Some(entry)) = (same, entry) {
                entry.seen = self.generation;
                entry.value = value;
                if fingerprint.is_some() {
                    entry.fingerprint = fingerprint;
                }
                return id;
            }
            self.entries.remove(&id);
        }
        let id = self.next;
        self.next += 1;
        self.ids.insert(key.clone(), id);
        self.entries.insert(
            id,
            Entry {
                key: key.clone(),
                value,
                fingerprint,
                seen: self.generation,
            },
        );
        id
    }

    pub fn get(&self, id: u64) -> Option<&V> {
        self.entries.get(&id).map(|entry| &entry.value)
    }

    pub fn existing(&self, key: &K) -> Option<u64> {
        self.ids
            .get(key)
            .copied()
            .filter(|id| self.entries.contains_key(id))
    }

    /// Forgets elements not seen in the last eight walks; their ids are never reused.
    pub fn prune(&mut self) {
        if self.generation <= 8 {
            return;
        }
        let cutoff = self.generation - 8;
        let old: Vec<u64> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.seen < cutoff)
            .map(|(id, _)| *id)
            .collect();
        for id in old {
            if let Some(entry) = self.entries.remove(&id) {
                self.ids.remove(&entry.key);
            }
        }
    }

    /// Drops every element, keeping the counter so old ids never resolve to new elements.
    pub fn clear(&mut self) {
        self.ids.clear();
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::Ids;

    #[test]
    fn an_element_keeps_its_id_across_looks() {
        let mut ids: Ids<String, &str> = Ids::default();
        ids.begin_walk();
        let save = ids.id(&"42.1".into(), "save", None);
        let open = ids.id(&"42.2".into(), "open", None);
        ids.begin_walk();
        assert_eq!(ids.id(&"42.2".into(), "open", None), open);
        assert_eq!(ids.id(&"42.1".into(), "save", None), save);
        assert_ne!(save, open);
        assert_eq!(ids.get(save), Some(&"save"));
    }

    #[test]
    fn a_recycled_row_gets_a_new_id_and_the_old_one_stops_resolving() {
        let mut ids: Ids<String, &str> = Ids::default();
        let first = ids.id(&"row".into(), "a", Some("row|Alice".into()));
        let second = ids.id(&"row".into(), "b", Some("row|Bob".into()));
        assert_ne!(first, second);
        assert!(ids.get(first).is_none());
        assert_eq!(ids.existing(&"row".into()), Some(second));
    }

    #[test]
    fn forgotten_elements_never_hand_their_id_to_another() {
        let mut ids: Ids<String, ()> = Ids::default();
        ids.begin_walk();
        let gone = ids.id(&"gone".into(), (), None);
        for _ in 0..10 {
            ids.begin_walk();
            ids.id(&"kept".into(), (), None);
        }
        ids.prune();
        assert!(ids.get(gone).is_none());
        assert!(ids.id(&"gone".into(), (), None) > gone);
        ids.clear();
        assert!(ids.get(gone).is_none());
        assert!(ids.id(&"other".into(), (), None) > gone + 1);
    }
}
