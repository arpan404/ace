// SPDX-License-Identifier: Apache-2.0
//! Short, stable element refs for device agents (`packages/devices/src/sim-refs.ts`),
//! shared by the `sim_*` tools and the `ace sim` CLI.
//!
//! Each agent gets its own numbering per device. An element keeps its ref across
//! reads while it stays on screen (matched by the platform's ref, else by role,
//! name and frame), so a ref an agent holds stays valid until the element itself
//! goes. Pure: no I/O.

use ace_json::{JsString, Number, Value};
use indexmap::IndexMap;

/// `simRefPattern`: `@e3` or `e3`, one to seven digits with no leading zero.
pub const MAX_REF_DIGITS: usize = 7;
/// Scopes kept, least recently used dropped first.
pub const MAX_SCOPES: usize = 128;
/// Elements kept per scope, oldest dropped first.
pub const MAX_ELEMENTS: usize = 2048;

/// A node's frame, in the source's coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One accessibility node as the platform returned it.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    /// The platform's own ref for the node (Android's dump hash, the iOS AX id, …).
    pub reference: JsString,
    pub role: JsString,
    pub name: JsString,
    pub value: Option<JsString>,
    pub secondary_actions: Vec<JsString>,
    pub description: Option<JsString>,
    pub bounds: Bounds,
    pub states: Vec<String>,
    pub actions: Vec<String>,
    pub children: Vec<Node>,
}

/// A `sim_ui` node as agents see it: refs only on nodes they can act on.
#[derive(Debug, Clone, PartialEq)]
pub struct SimNode {
    /// `@e3` when the node is actionable.
    pub reference: Option<String>,
    pub role: JsString,
    pub name: JsString,
    pub value: Option<JsString>,
    pub secondary_actions: Vec<JsString>,
    pub description: Option<JsString>,
    pub bounds: Bounds,
    pub states: Vec<String>,
    pub actions: Vec<String>,
    pub children: Vec<SimNode>,
}

/// The element behind an agent ref, as it was last seen.
#[derive(Debug, Clone, PartialEq)]
pub struct SimElement {
    pub reference: String,
    pub role: JsString,
    pub name: JsString,
    pub bounds: Bounds,
    pub actions: Vec<String>,
}

/// One read's labels, and the elements it saw by ref.
#[derive(Debug, Clone, PartialEq)]
pub struct Labelled {
    pub nodes: Vec<SimNode>,
    pub seen: IndexMap<String, SimElement>,
}

#[derive(Debug, Default)]
struct Scope {
    next: u64,
    /// `e3` → element, oldest first, so the cap evicts the refs seen longest ago.
    elements: IndexMap<String, SimElement>,
    by_ref: IndexMap<String, String>,
    by_print: IndexMap<String, String>,
}

/// `SimRefs`: one numbering per agent and device.
#[derive(Debug, Default)]
pub struct SimRefs {
    scopes: IndexMap<String, Scope>,
}

impl SimRefs {
    pub fn new() -> Self {
        Self::default()
    }

    /// `label`: one read of the UI, with `@eN` refs on actionable nodes and the
    /// elements this read saw, by ref, for re-validation.
    pub fn label(&mut self, owner: &str, device: &str, nodes: &[Node]) -> Labelled {
        let key = scope_key(owner, device);
        let mut scope = match self.scopes.shift_remove(&key) {
            Some(scope) => scope,
            None => {
                self.evict_oldest_scope();
                Scope::default()
            }
        };
        let mut seen: IndexMap<String, SimElement> = IndexMap::new();
        let labelled = nodes
            .iter()
            .map(|node| visit(node, &mut scope, &mut seen))
            .collect();
        for (id, element) in &seen {
            remember(&mut scope, id, element);
        }
        self.scopes.insert(key, scope);
        Labelled {
            nodes: labelled,
            seen,
        }
    }

    /// `element`: the element an agent ref named when it was last seen, if this
    /// agent was given it.
    pub fn element(&self, owner: &str, device: &str, reference: &str) -> Option<&SimElement> {
        self.scopes
            .get(&scope_key(owner, device))?
            .elements
            .get(bare(reference))
    }

    fn evict_oldest_scope(&mut self) {
        while self.scopes.len() >= MAX_SCOPES {
            let Some(oldest) = self.scopes.keys().next().cloned() else {
                return;
            };
            self.scopes.shift_remove(&oldest);
        }
    }
}

/// `scope`'s key: `JSON.stringify([owner, deviceId])`.
fn scope_key(owner: &str, device: &str) -> String {
    ace_json::to_string(&ace_json::json!([owner, device]))
}

fn visit(node: &Node, scope: &mut Scope, seen: &mut IndexMap<String, SimElement>) -> SimNode {
    let children = node
        .children
        .iter()
        .map(|child| visit(child, scope, seen))
        .collect();
    let mut labelled = SimNode {
        reference: None,
        role: node.role.clone(),
        name: node.name.clone(),
        value: node.value.clone(),
        secondary_actions: node.secondary_actions.clone(),
        description: node.description.clone(),
        bounds: node.bounds,
        states: node.states.clone(),
        actions: node.actions.clone(),
        children,
    };
    if node.actions.is_empty() {
        return labelled;
    }
    let print = fingerprint(&node.role, &node.name, node.bounds);
    let known = [
        scope.by_ref.get(node.reference.as_str()),
        scope.by_print.get(&print),
    ]
    .into_iter()
    .flatten()
    .find(|id| !seen.contains_key(*id))
    .cloned();
    let id = match known {
        Some(id) => id,
        None => {
            scope.next = scope.next.saturating_add(1);
            format!("e{}", scope.next)
        }
    };
    let element = SimElement {
        reference: node.reference.to_string(),
        role: node.role.clone(),
        name: node.name.clone(),
        bounds: node.bounds,
        actions: node.actions.clone(),
    };
    seen.insert(id.clone(), element);
    labelled.reference = Some(format!("@{id}"));
    labelled
}

/// `remember`: the element's ref and print now point at `id`, replacing whatever
/// `id` was before, and the oldest go once the cap is passed.
fn remember(scope: &mut Scope, id: &str, element: &SimElement) {
    if let Some(previous) = scope.elements.shift_remove(id) {
        if scope
            .by_ref
            .get(previous.reference.as_str())
            .is_some_and(|value| value == id)
        {
            scope.by_ref.shift_remove(previous.reference.as_str());
        }
        let print = fingerprint(&previous.role, &previous.name, previous.bounds);
        if scope.by_print.get(&print).is_some_and(|value| value == id) {
            scope.by_print.shift_remove(&print);
        }
    }
    scope.elements.insert(id.to_owned(), element.clone());
    scope
        .by_ref
        .insert(element.reference.clone(), id.to_owned());
    scope.by_print.insert(
        fingerprint(&element.role, &element.name, element.bounds),
        id.to_owned(),
    );
    while scope.elements.len() > MAX_ELEMENTS {
        let Some((oldest, gone)) = scope
            .elements
            .first()
            .map(|(oldest, gone)| (oldest.clone(), gone.clone()))
        else {
            return;
        };
        scope.elements.shift_remove(&oldest);
        if scope
            .by_ref
            .get(gone.reference.as_str())
            .is_some_and(|value| value == &oldest)
        {
            scope.by_ref.shift_remove(gone.reference.as_str());
        }
        let print = fingerprint(&gone.role, &gone.name, gone.bounds);
        if scope
            .by_print
            .get(&print)
            .is_some_and(|value| value == &oldest)
        {
            scope.by_print.shift_remove(&print);
        }
    }
}

/// `fingerprint`: same role, name and frame is the same element, even when a
/// platform re-numbers its own refs.
fn fingerprint(role: &JsString, name: &JsString, bounds: Bounds) -> String {
    let number = |value: f64| Value::Number(Number::from(value));
    ace_json::to_string(&Value::Array(ace_json::Array::from(vec![
        Value::String(role.clone()),
        Value::String(name.clone()),
        number(bounds.x),
        number(bounds.y),
        number(bounds.w),
        number(bounds.h),
    ])))
}

/// `bare`: `e3` for `@e3` too.
pub fn bare(reference: &str) -> &str {
    reference.strip_prefix('@').unwrap_or(reference)
}

/// `simRefPattern`: `@?e[1-9]\\d{0,6}` — what an agent may pass as a ref.
pub fn is_ref(reference: &str) -> bool {
    let digits = bare(reference);
    let Some(rest) = digits.strip_prefix('e') else {
        return false;
    };
    if rest.is_empty() || rest.len() > MAX_REF_DIGITS {
        return false;
    }
    let mut bytes = rest.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_digit() && first != b'0' && bytes.all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests;
