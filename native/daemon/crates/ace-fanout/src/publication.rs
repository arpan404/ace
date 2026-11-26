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

use ace_json::JsString;

use crate::event::DeliveryEvent;

/// One listener's registration: its id, so it can be stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ListenerId(pub u64);

type Listener = Box<dyn FnMut(&[DeliveryEvent], u64)>;

/// One store's publication, shared by every subscription on it.
#[derive(Default)]
pub struct Publication {
    /// Listeners for whole batches: the sidebar's list.
    listeners: BTreeMap<u64, Listener>,
    /// Thread routes, each hearing only its thread's events from a batch.
    threads: BTreeMap<u64, Route>,
    /// How many routes each thread has, so a batch is split only for threads someone watches.
    watched: BTreeMap<JsString, usize>,
    next: u64,
    head: u64,
}

struct Route {
    thread: JsString,
    listener: Listener,
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

    /// Register for one thread's events, as `routeThread` does: every thread subscription on
    /// this publication shares one split of each batch, and a route hears the batch's head even
    /// when the thread had no event in it.
    pub fn route_thread(&mut self, thread: JsString, listener: Listener) -> ListenerId {
        self.next += 1;
        *self.watched.entry(thread.clone()).or_insert(0) += 1;
        self.threads.insert(self.next, Route { thread, listener });
        ListenerId(self.next)
    }

    pub fn unsubscribe(&mut self, id: ListenerId) {
        if let Some(route) = self.threads.remove(&id.0) {
            let count = self
                .watched
                .get(&route.thread)
                .copied()
                .unwrap_or(1)
                .saturating_sub(1);
            if count == 0 {
                self.watched.remove(&route.thread);
            } else {
                self.watched.insert(route.thread, count);
            }
            return;
        }
        self.listeners.remove(&id.0);
    }

    pub fn len(&self) -> usize {
        self.listeners.len() + self.threads.len()
    }

    pub fn is_empty(&self) -> bool {
        self.listeners.is_empty() && self.threads.is_empty()
    }

    /// The head sequence: the highest published, or 0 before anything was.
    pub fn head(&self) -> u64 {
        self.head
    }

    /// A committed batch: its head is its last event's sequence, exactly as a listener sees it.
    /// Returns that head.
    ///
    /// The batch is split by thread once, for the threads that are watched; batch listeners get
    /// it whole. Each subscriber's `DeliveryEvent` clones share the event, so its wire form and
    /// interaction summary are made once (`DeliveryEvent::wired`).
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
        if self.threads.is_empty() {
            return head;
        }
        let mut by_thread: BTreeMap<JsString, Vec<DeliveryEvent>> = BTreeMap::new();
        for event in batch {
            let Some(thread) = event.thread_id() else {
                continue;
            };
            if !self.watched.contains_key(thread) {
                continue;
            }
            by_thread
                .entry(thread.clone())
                .or_default()
                .push(event.clone());
        }
        let none: &[DeliveryEvent] = &[];
        for route in self.threads.values_mut() {
            let events = by_thread.get(&route.thread).map_or(none, Vec::as_slice);
            (route.listener)(events, head);
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
        event_on(seq, "t")
    }

    /// A batch as a thread route heard it: thread, head and the sequencess it carried.
    type Heard = (String, u64, Vec<f64>);

    fn event_on(seq: u64, thread: &str) -> DeliveryEvent {
        DeliveryEvent::parse(&format!(
            r#"{{"id":"e{seq}","seq":{seq},"at":1,"threadId":"{thread}","payload":{{"type":"thread.updated","title":"t"}}}}"#
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

    /// `routeThread`: a thread route hears only its thread's events, and the batch's head even
    /// when its thread had none.
    #[test]
    fn a_thread_route_hears_only_its_threads_events_and_the_batch_head() {
        let seen: Rc<RefCell<Vec<Heard>>> = Rc::new(RefCell::new(Vec::new()));
        let mut publication = Publication::new();
        for thread in ["t", "u", "unseen"] {
            let seen = seen.clone();
            let owned = thread.to_owned();
            publication.route_thread(
                JsString::from(thread),
                Box::new(move |events, head| {
                    seen.borrow_mut().push((
                        owned.clone(),
                        head,
                        events
                            .iter()
                            .filter_map(DeliveryEvent::seq)
                            .collect::<Vec<_>>(),
                    ));
                }),
            );
        }
        publication.publish(&[event_on(1, "t"), event_on(2, "u"), event_on(3, "t")]);
        assert_eq!(
            seen.borrow().as_slice(),
            [
                ("t".to_owned(), 3, vec![1.0, 3.0]),
                ("u".to_owned(), 3, vec![2.0]),
                ("unseen".to_owned(), 3, Vec::new()),
            ]
        );
    }

    /// Two routes on one thread both hear it; the thread is watched until the last is stopped.
    #[test]
    fn thread_routes_share_their_thread_until_the_last_stops() {
        let first = Rc::new(RefCell::new(0_usize));
        let second = Rc::new(RefCell::new(0_usize));
        let mut publication = Publication::new();
        let one = {
            let first = first.clone();
            publication.route_thread(
                JsString::from("t"),
                Box::new(move |_, _| *first.borrow_mut() += 1),
            )
        };
        let two = {
            let second = second.clone();
            publication.route_thread(
                JsString::from("t"),
                Box::new(move |_, _| *second.borrow_mut() += 1),
            )
        };
        publication.publish(&[event(1)]);
        publication.unsubscribe(one);
        publication.publish(&[event(2)]);
        assert_eq!((*first.borrow(), *second.borrow()), (1, 2));
        assert_eq!(publication.len(), 1);
        publication.unsubscribe(two);
        assert!(publication.is_empty());
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
