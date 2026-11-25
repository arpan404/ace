// SPDX-License-Identifier: Apache-2.0
//! The record budget (E5.3 step 2): `RecordBudget` (`record-cache.ts:14`) and `BoundedCache`
//! (`packages/provider-kit/src/bounded-cache.ts`) as one type. One budget per repository, shared
//! by every resident snapshot, exactly as the TypeScript shares `recordBudget`
//! (`repository.ts:93`).
//!
//! - At most **8192 entries** and **8,388,608 weighted bytes**. An entry's weight is **4 x the
//!   UTF-8 byte length** of its JSON (`record-cache.ts:34`, "charge decoded strings as well").
//!   A lone surrogate counts 3 bytes, as `Buffer.byteLength` does.
//! - LRU: a `get` hit and a `set` both move the entry to newest. A `set` whose weight alone
//!   exceeds the byte budget keeps nothing and returns false, so the section does not record the
//!   key. Eviction drops oldest entries until both limits hold and removes the key from its
//!   owning section's resident set; an explicit `delete` is not an eviction.
//! - A section is a serial prefix plus the set of its keys still resident, so a section that
//!   cycles 200,000 keys through a full budget keeps only the keys still cached.

use std::any::Any;
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use indexmap::IndexMap;

/// The shared budget's limits (`RecordBudget`'s defaults, `record-cache.ts:16`).
pub const MAX_ENTRIES: usize = 8192;
pub const MAX_BYTES: usize = 8_388_608;

/// One cached record: the decoded value, its JSON and its JSON byte count. The budget charges
/// four times the bytes.
#[derive(Clone)]
pub struct Cached<T> {
    pub value: Rc<T>,
    pub json: String,
    pub bytes: usize,
}

struct Entry {
    record: Rc<dyn Any>,
    /// The charge (four times the JSON bytes).
    weight: usize,
    section: u64,
    key: String,
}

/// The one budget every resident snapshot shares.
pub struct RecordBudget {
    max_entries: usize,
    max_bytes: usize,
    entries: IndexMap<(u64, String), Entry>,
    bytes: usize,
    evicted: u64,
    serial: u64,
    resident: RefCell<std::collections::HashMap<u64, HashSet<String>>>,
}

/// A fresh section of `budget`: a serial prefix and the set of its resident keys.
pub fn section(budget: &Rc<RefCell<RecordBudget>>) -> BudgetSection {
    let serial = {
        let mut budget = budget.borrow_mut();
        budget.serial += 1;
        budget.serial
    };
    BudgetSection {
        budget: Rc::clone(budget),
        serial,
        off: Rc::new(std::cell::Cell::new(false)),
    }
}

impl Default for RecordBudget {
    fn default() -> RecordBudget {
        RecordBudget::new(MAX_ENTRIES, MAX_BYTES)
    }
}

impl RecordBudget {
    pub fn new(max_entries: usize, max_bytes: usize) -> RecordBudget {
        assert!(max_entries >= 1 && max_bytes >= 1, "Invalid cache budget");
        RecordBudget {
            max_entries,
            max_bytes,
            entries: IndexMap::new(),
            bytes: 0,
            evicted: 0,
            serial: 0,
            resident: RefCell::new(std::collections::HashMap::new()),
        }
    }

    pub fn size(&self) -> usize {
        self.entries.len()
    }

    pub fn byte_length(&self) -> usize {
        self.bytes
    }

    pub fn evictions(&self) -> u64 {
        self.evicted
    }

    /// The keys of one section still resident in the budget.
    pub fn resident(&self, section: u64) -> usize {
        self.resident
            .borrow()
            .get(&section)
            .map(HashSet::len)
            .unwrap_or(0)
    }
}

/// One section's handle on the shared budget.
#[derive(Clone)]
pub struct BudgetSection {
    budget: Rc<RefCell<RecordBudget>>,
    serial: u64,
    /// A released section caches nothing; its reads go to SQLite (`uncachedSection`).
    off: Rc<std::cell::Cell<bool>>,
}

impl BudgetSection {
    /// A hit moves the entry to newest.
    pub fn get<T: Clone + 'static>(&self, key: &str) -> Option<Cached<T>> {
        if self.off.get() {
            return None;
        }
        let mut budget = self.budget.borrow_mut();
        let id = (self.serial, key.to_owned());
        let entry = budget.entries.shift_remove(&id)?;
        let cached = Rc::downcast::<Cached<T>>(Rc::clone(&entry.record))
            .ok()
            .map(|value| (*value).clone());
        budget.entries.insert(id, entry);
        cached
    }

    /// False when the value alone exceeds the byte budget, so nothing was kept.
    pub fn set<T: Clone + 'static>(&self, key: &str, value: Cached<T>, bytes: usize) -> bool {
        if self.off.get() {
            return false;
        }
        let mut budget = self.budget.borrow_mut();
        let weight = bytes * 4;
        let id = (self.serial, key.to_owned());
        budget.entries.shift_remove(&id);
        if weight > budget.max_bytes {
            return false;
        }
        budget.entries.insert(
            id,
            Entry {
                record: Rc::new(value),
                weight,
                section: self.serial,
                key: key.to_owned(),
            },
        );
        budget.bytes += weight;
        budget
            .resident
            .borrow_mut()
            .entry(self.serial)
            .or_default()
            .insert(key.to_owned());
        while budget.entries.len() > budget.max_entries || budget.bytes > budget.max_bytes {
            let Some((oldest, _)) = budget.entries.first() else {
                break;
            };
            let oldest = oldest.clone();
            remove(&mut budget, &oldest);
            budget.evicted += 1;
        }
        true
    }

    /// Drop this section's entries and cache nothing from now on (`uncachedSection`).
    pub fn disable(&self) {
        self.clear();
        self.off.set(true);
    }

    /// An explicit delete, which is never an eviction.
    pub fn delete(&self, key: &str) {
        let mut budget = self.budget.borrow_mut();
        remove(&mut budget, &(self.serial, key.to_owned()));
    }

    /// Drop every entry this section cached.
    pub fn clear(&self) {
        let mut budget = self.budget.borrow_mut();
        let keys: Vec<String> = budget
            .resident
            .borrow()
            .get(&self.serial)
            .map(|keys| keys.iter().cloned().collect())
            .unwrap_or_default();
        for key in keys {
            remove(&mut budget, &(self.serial, key));
        }
    }
}

fn remove(budget: &mut RecordBudget, id: &(u64, String)) {
    if let Some(entry) = budget.entries.shift_remove(id) {
        budget.bytes -= entry.weight;
        if let Some(keys) = budget.resident.borrow_mut().get_mut(&entry.section) {
            keys.remove(&entry.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cached(text: &str) -> Cached<String> {
        Cached {
            value: Rc::new(text.to_owned()),
            json: text.to_owned(),
            bytes: text.len(),
        }
    }

    #[test]
    fn sections_share_one_budget_and_an_evicted_record_is_gone() {
        let budget = Rc::new(RefCell::new(RecordBudget::new(2, MAX_BYTES)));
        let first = section(&budget);
        let second = section(&budget);
        assert!(first.set("a", cached("one"), 3));
        assert!(second.set("b", cached("two"), 3));
        assert!(second.set("c", cached("three"), 5));
        // The oldest entry, `a`, was pushed out by the second section's `c`.
        assert!(first.get::<String>("a").is_none());
        assert_eq!(
            second
                .get::<String>("b")
                .map(|c| c.value.as_str().to_owned()),
            Some("two".to_owned())
        );
        assert_eq!(budget.borrow().evictions(), 1);
        assert_eq!(budget.borrow().resident(first.serial), 0);
    }

    #[test]
    fn a_record_heavier_than_the_byte_budget_is_not_kept() {
        let budget = Rc::new(RefCell::new(RecordBudget::new(8, 10)));
        let section = section(&budget);
        assert!(
            !section.set("big", cached("x"), 3),
            "12 weighted bytes > 10"
        );
        assert!(section.get::<String>("big").is_none());
    }

    #[test]
    fn a_section_cycling_many_keys_keeps_no_bookkeeping_for_evicted_keys() {
        let budget = Rc::new(RefCell::new(RecordBudget::new(64, MAX_BYTES)));
        let long_lived = section(&budget);
        let filler = section(&budget);
        for index in 0..200_000 {
            long_lived.set(&format!("k{index}"), cached("v"), 1);
        }
        // Another section's 64 entries fill the budget exactly.
        for index in 0..64 {
            filler.set(&format!("f{index}"), cached("v"), 1);
        }
        assert_eq!(
            budget.borrow().resident(long_lived.serial),
            0,
            "the long-lived section keeps no keys once they are evicted"
        );
        assert_eq!(budget.borrow().size(), 64);
    }

    #[test]
    fn a_get_moves_the_entry_to_newest_and_an_explicit_delete_is_not_an_eviction() {
        let budget = Rc::new(RefCell::new(RecordBudget::new(2, MAX_BYTES)));
        let section = section(&budget);
        section.set("a", cached("1"), 1);
        section.set("b", cached("2"), 1);
        assert!(section.get::<String>("a").is_some());
        section.set("c", cached("3"), 1);
        // `b` was oldest after `a`'s hit.
        assert!(section.get::<String>("b").is_none());
        assert!(section.get::<String>("a").is_some());
        section.delete("a");
        assert_eq!(budget.borrow().evictions(), 1);
    }
}
