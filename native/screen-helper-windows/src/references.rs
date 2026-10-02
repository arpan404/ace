use std::collections::{BTreeMap, HashMap};
/// Runtime IDs are provider identities. Monotonic refs cannot alias evicted or replaced elements.
pub struct References<T> {
    entries: HashMap<String, (String, T, u64)>,
    refs: HashMap<String, String>,
    order: BTreeMap<u64, String>,
    clock: u64,
    capacity: usize,
}
impl<T: Clone> References<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: HashMap::new(),
            refs: HashMap::new(),
            order: BTreeMap::new(),
            clock: 0,
            capacity: capacity.max(1),
        }
    }
    pub fn retain(&mut self, identity: String, element: T) -> String {
        self.clock += 1;
        let reference = if let Some((reference, _, old)) = self.entries.remove(&identity) {
            self.order.remove(&old);
            reference
        } else {
            if self.entries.len() == self.capacity {
                if let Some((_, oldest)) = self.order.pop_first() {
                    if let Some((reference, _, _)) = self.entries.remove(&oldest) {
                        self.refs.remove(&reference);
                    }
                }
            }
            let reference = format!("w{}", self.clock);
            self.refs.insert(reference.clone(), identity.clone());
            reference
        };
        self.order.insert(self.clock, identity.clone());
        self.entries
            .insert(identity, (reference.clone(), element, self.clock));
        reference
    }
    pub fn get(&self, reference: &str) -> Option<T> {
        self.refs
            .get(reference)
            .and_then(|id| self.entries.get(id))
            .map(|(_, value, _)| value.clone())
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.refs.clear();
        self.order.clear();
    }
}
