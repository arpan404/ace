// SPDX-License-Identifier: Apache-2.0
//! The store's publication: committed event batches, in sequence order, after the commit. Ports
//! the seam `store.subscribe(listener)` gives subscriptions in the TypeScript (behaviour.md §9:
//! "Events reach subscribers only after commit, in sequence order").
//!
//! `ace-store` calls [`Publication::publish`] once for every committed batch, whichever engine
//! wrote it; a subscription's shell registers a listener before its first read and forwards each
//! batch to [`crate::Subscription::hear`] or [`crate::SidebarSubscription::hear`]. Nothing here
//! reads a store, owns a thread or schedules work.

use std::collections::BTreeMap;

use crate::event::DeliveryEvent;

/// One listener's registration: its id, so it can be stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ListenerId(pub u64);

type Listener = Box<dyn FnMut(&[DeliveryEvent], u64)>;

/// One store's publication, shared by every subscription on it.
#[derive(Default)]
pub struct Publication {
    listeners: BTreeMap<u64, Listener>,
    next: u64,
    head: u64,
}

impl Publication {
    pub fn new() -> Publication {
        Publication::default()
    }

    /// Register for live batches. The shell must do this before the subscription's first read.
    pub fn subscribe(&mut self, listener: Listener) -> ListenerId {
        self.next += 1;
        self.listeners.insert(self.next, listener);
        ListenerId(self.next)
    }

    pub fn unsubscribe(&mut self, id: ListenerId) {
        self.listeners.remove(&id.0);
    }

    pub fn len(&self) -> usize {
        self.listeners.len()
    }

    pub fn is_empty(&self) -> bool {
        self.listeners.is_empty()
    }

    /// The head sequence: the highest published, or 0 before anything was.
    pub fn head(&self) -> u64 {
        self.head
    }

    /// A committed batch: its head is its last event's sequence, exactly as a listener sees it.
    /// Returns that head.
    pub fn publish(&mut self, batch: &[DeliveryEvent]) -> u64 {
        let head = batch
            .last()
            .and_then(DeliveryEvent::seq)
            .map(|seq| seq as u64)
            .unwrap_or(self.head);
        self.head = self.head.max(head);
        for listener in self.listeners.values_mut() {
            listener(batch, head);
        }
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn event(seq: u64) -> DeliveryEvent {
        DeliveryEvent::parse(&format!(
            r#"{{"id":"e{seq}","seq":{seq},"at":1,"threadId":"t","payload":{{"type":"thread.updated","title":"t"}}}}"#
        ))
        .expect("parse event")
    }

    #[test]
    fn a_batch_reaches_every_listener_in_order_with_its_head() {
        let seen: Rc<RefCell<Vec<(u64, usize)>>> = Rc::new(RefCell::new(Vec::new()));
        let mut publication = Publication::new();
        for _ in 0..2 {
            let seen = seen.clone();
            publication.subscribe(Box::new(move |batch, head| {
                seen.borrow_mut().push((head, batch.len()));
            }));
        }
        assert_eq!(publication.publish(&[event(1), event(2)]), 2);
        assert_eq!(publication.publish(&[event(3)]), 3);
        assert_eq!(publication.head(), 3);
        assert_eq!(seen.borrow().as_slice(), &[(2, 2), (2, 2), (3, 1), (3, 1)]);
    }

    #[test]
    fn an_unsubscribed_listener_hears_nothing_more() {
        let seen = Rc::new(RefCell::new(0_usize));
        let mut publication = Publication::new();
        let listener = {
            let seen = seen.clone();
            publication.subscribe(Box::new(move |_, _| *seen.borrow_mut() += 1))
        };
        publication.publish(&[event(1)]);
        publication.unsubscribe(listener);
        publication.publish(&[event(2)]);
        assert_eq!(*seen.borrow(), 1);
        assert!(publication.is_empty());
    }
}
