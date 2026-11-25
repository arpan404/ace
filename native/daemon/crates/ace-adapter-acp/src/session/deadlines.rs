// SPDX-License-Identifier: Apache-2.0
//! Named one-shot deadlines (`packages/adapter-acp/src/deadlines.ts`).
//!
//! Sans-IO: arming a logical key cancels its previous timer (if any) and emits a fresh
//! generation-tagged wire key, so a stale timer firing after re-arming or clearing is
//! ignored.

use indexmap::IndexMap;

/// Timer commands emitted by [`Deadlines`] for the shell to schedule or cancel.
#[derive(Debug, Clone, PartialEq)]
pub enum DeadlineEffect {
    Arm { key: String, ms: f64 },
    Cancel { key: String },
}

/// Named one-shot deadlines; arming a key again replaces its timer (`deadlines.ts:2`–`:28`).
#[derive(Debug, Default)]
pub struct Deadlines {
    next_gen: u64,
    /// Logical deadline name -> active wire timer key.
    active: IndexMap<String, String>,
    /// Active wire timer key -> logical deadline name.
    by_wire: IndexMap<String, String>,
}

impl Deadlines {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arm `name` for `delay_ms`, replacing any prior timer on `name`.
    pub fn arm(&mut self, name: &str, delay_ms: f64) -> Vec<DeadlineEffect> {
        let mut effects = self.clear(name);
        self.next_gen = self.next_gen.saturating_add(1);
        let wire_key = format!("deadline:{}:{name}", self.next_gen);
        self.active.insert(name.to_owned(), wire_key.clone());
        self.by_wire.insert(wire_key.clone(), name.to_owned());
        effects.push(DeadlineEffect::Arm {
            key: wire_key,
            ms: delay_ms,
        });
        effects
    }

    /// Whether `name` currently has an armed deadline.
    pub fn has(&self, name: &str) -> bool {
        self.active.contains_key(name)
    }

    /// Clear `name`, emitting a cancel if it was armed.
    pub fn clear(&mut self, name: &str) -> Vec<DeadlineEffect> {
        let Some(wire_key) = self.active.shift_remove(name) else {
            return Vec::new();
        };
        self.by_wire.shift_remove(&wire_key);
        vec![DeadlineEffect::Cancel { key: wire_key }]
    }

    /// Clear every armed deadline in insertion order.
    pub fn clear_all(&mut self) -> Vec<DeadlineEffect> {
        let active = std::mem::take(&mut self.active);
        self.by_wire.clear();
        active
            .into_values()
            .map(|key| DeadlineEffect::Cancel { key })
            .collect()
    }

    /// Fire a wire timer key. Returns `Some(logical_name)` if and only if `wire_key` is
    /// still the current active timer for its name, removing it atomically so it runs once.
    pub fn fire(&mut self, wire_key: &str) -> Option<String> {
        let name = self.by_wire.shift_remove(wire_key)?;
        if self.active.get(&name).map(String::as_str) == Some(wire_key) {
            self.active.shift_remove(&name);
            Some(name)
        } else {
            None
        }
    }

    /// Active wire key for a logical name (useful for tests and inspection).
    pub fn wire_key(&self, name: &str) -> Option<&str> {
        self.active.get(name).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::{DeadlineEffect, Deadlines};

    #[test]
    fn arming_replaces_existing_timer_and_ignores_stale_fires() {
        let mut deadlines = Deadlines::new();
        let first = deadlines.arm("open", 30_000.0);
        assert_eq!(
            first,
            vec![DeadlineEffect::Arm {
                key: "deadline:1:open".to_owned(),
                ms: 30_000.0,
            }]
        );
        assert!(deadlines.has("open"));

        let second = deadlines.arm("open", 30_000.0);
        assert_eq!(
            second,
            vec![
                DeadlineEffect::Cancel {
                    key: "deadline:1:open".to_owned(),
                },
                DeadlineEffect::Arm {
                    key: "deadline:2:open".to_owned(),
                    ms: 30_000.0,
                },
            ]
        );
        // Stale timer firing is a no-op; live timer stays armed.
        assert_eq!(deadlines.fire("deadline:1:open"), None);
        assert!(deadlines.has("open"));

        // Live timer fires once and clears itself.
        assert_eq!(deadlines.fire("deadline:2:open"), Some("open".to_owned()));
        assert!(!deadlines.has("open"));
        assert_eq!(deadlines.fire("deadline:2:open"), None);
    }

    #[test]
    fn clear_and_clear_all_cancel_in_order_and_suppress_later_fires() {
        let mut deadlines = Deadlines::new();
        let _ = deadlines.arm("root", 12_000.0);
        let _ = deadlines.arm("children", 12_000.0);
        let _ = deadlines.arm("shells", 12_000.0);

        assert_eq!(
            deadlines.clear("children"),
            vec![DeadlineEffect::Cancel {
                key: "deadline:2:children".to_owned(),
            }]
        );
        assert_eq!(deadlines.clear("children"), Vec::new());
        assert_eq!(deadlines.fire("deadline:2:children"), None);

        assert_eq!(
            deadlines.clear_all(),
            vec![
                DeadlineEffect::Cancel {
                    key: "deadline:1:root".to_owned(),
                },
                DeadlineEffect::Cancel {
                    key: "deadline:3:shells".to_owned(),
                },
            ]
        );
        assert!(!deadlines.has("root"));
        assert!(!deadlines.has("shells"));
        assert_eq!(deadlines.fire("deadline:1:root"), None);
        assert_eq!(deadlines.fire("deadline:3:shells"), None);
    }
}
