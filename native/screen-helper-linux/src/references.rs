//! Bounded public references keep provider object identities private.
use std::collections::{HashMap, VecDeque};
pub struct References<T> {
    values: HashMap<String, T>,
    identities: HashMap<String, String>,
    order: VecDeque<String>,
    capacity: usize,
    sequence: u64,
}
impl<T: Clone> References<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            values: HashMap::new(),
            identities: HashMap::new(),
            order: VecDeque::new(),
            capacity: capacity.max(1),
            sequence: 0,
        }
    }
    pub fn retain(&mut self, identity: String, value: T) -> String {
        if let Some(reference) = self.identities.get(&identity) {
            return reference.clone();
        }
        self.sequence += 1;
        if self.values.len() == self.capacity {
            if let Some(old) = self.order.pop_front() {
                if let Some(reference) = self.identities.remove(&old) {
                    self.values.remove(&reference);
                }
            }
        }
        let reference = format!("u{}", self.sequence);
        self.values.insert(reference.clone(), value);
        self.identities.insert(identity.clone(), reference.clone());
        self.order.push_back(identity);
        reference
    }
    pub fn get(&self, reference: &str) -> Option<&T> {
        self.values.get(reference)
    }
    pub fn remove(&mut self, identity: &str) {
        if let Some(reference) = self.identities.remove(identity) {
            self.values.remove(&reference);
            self.order.retain(|key| key != identity);
        }
    }
    pub fn clear(&mut self) {
        self.values.clear();
        self.identities.clear();
        self.order.clear();
    }
}
