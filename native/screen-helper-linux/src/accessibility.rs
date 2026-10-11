//! Accessibility I/O. Ref cache stores identity only; properties are read fresh.
use crate::protocol::{Fault, Query, Result, internal};
use atspi::{State, StateSet};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use zbus::{Connection, Proxy, zvariant::OwnedObjectPath};

pub(crate) type Object = (String, OwnedObjectPath);
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    #[serde(rename = "ref")]
    pub reference: String,
    pub role: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub description: String,
    pub bounds: Bounds,
    pub states: Vec<String>,
    pub actions: Vec<String>,
    pub children: Vec<Node>,
}
pub struct Accessibility {
    conn: Connection,
    lifecycle: crate::accessibility_lifecycle::Lifecycle,
    lifecycle_generation: u64,
    pub(crate) refs: crate::references::References<Object>,
    pub(crate) scope: Option<Object>,
}
impl Accessibility {
    pub async fn connect() -> Result<Self> {
        let session = Connection::session().await.map_err(internal)?;
        let bus = Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
            .await
            .map_err(internal)?;
        let address: String = bus.call("GetAddress", &()).await.map_err(internal)?;
        let conn = zbus::connection::Builder::address(address.as_str())
            .map_err(internal)?
            .build()
            .await
            .map_err(internal)?;
        let result = Self::from_connection(conn).await?;
        let registry = Proxy::new(&result.conn, "org.a11y.atspi.Registry", "/org/a11y/atspi/registry", "org.a11y.atspi.Registry").await.map_err(internal)?;
        for event in ["object:children-changed", "object:state-changed:defunct"] {
            registry.call::<_, _, ()>("RegisterEvent", &(event,)).await.map_err(internal)?;
        }
        Ok(result)
    }
    async fn from_connection(conn: Connection) -> Result<Self> {
        let lifecycle = crate::accessibility_lifecycle::Lifecycle::observe(&conn).await?;
        Ok(Self {
            conn, lifecycle, lifecycle_generation: 0,
            refs: crate::references::References::new(4096), scope: None,
        })
    }
    fn synchronize_refs(&mut self) {
        let generation = self.lifecycle.generation();
        if self.lifecycle_generation != generation {
            self.refs.clear();
            self.lifecycle_generation = generation;
        }
    }
    pub(crate) async fn fence_refs(&mut self, object: &Object) -> Result<()> {
        let result = self.lifecycle.fence(&self.conn, object).await;
        self.synchronize_refs();
        if result.is_err() { self.refs.remove(&format!("{}{}", object.0, object.1)); }
        result
    }

    pub async fn scope_application(&mut self, identity: &str) -> Result<()> {
        self.clear();
        let registry = (
            "org.a11y.atspi.Registry".into(),
            OwnedObjectPath::try_from("/org/a11y/atspi/accessible/root").map_err(internal)?,
        );
        let root = self.proxy(&registry, "Accessible").await?;
        let count: i32 = root.get_property("ChildCount").await.map_err(internal)?;
        let dbus = zbus::fdo::DBusProxy::new(&self.conn)
            .await
            .map_err(internal)?;
        let mut selected = None;
        for index in 0..count.clamp(0, 256) {
            let app: Object = root
                .call("GetChildAtIndex", &(index,))
                .await
                .map_err(internal)?;
            let pid = dbus
                .get_connection_unix_process_id(app.0.as_str().try_into().map_err(internal)?)
                .await
                .map_err(internal)?;
            // Authenticate the application against kernel executable identity, never a mutable title.
            let executable = match std::fs::read_link(format!("/proc/{pid}/exe")) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if executable.file_name().and_then(|s| s.to_str()) != Some(identity) {
                continue;
            }
            let a = self.proxy(&app, "Accessible").await?;
            let n: i32 = a.get_property("ChildCount").await.map_err(internal)?;
            if n != 1 || selected.is_some() {
                return Err(Fault::new(
                    "bounds",
                    "Semantic target must have one unambiguous accessible window",
                ));
            }
            let window: Object = a
                .call("GetChildAtIndex", &(0i32,))
                .await
                .map_err(internal)?;
            selected = Some(window);
        }
        self.scope = selected;
        if self.scope.is_none() {
            return Err(Fault::new(
                "not_supported",
                "Approved executable has no accessible window",
            ));
        }
        Ok(())
    }
    pub(crate) async fn proxy(
        &self,
        object: &Object,
        interface: &str,
    ) -> Result<Proxy<'static>> {
        Proxy::new_owned(
            self.conn.clone(),
            object.0.clone(),
            object.1.clone(),
            format!("org.a11y.atspi.{interface}"),
        )
        .await
        .map_err(|e| Fault::new("target_gone", e.to_string()))
    }
    pub async fn scope(&mut self, pid: u32, bounds: &Bounds) -> Result<()> {
        self.clear();
        let registry = (
            "org.a11y.atspi.Registry".into(),
            OwnedObjectPath::try_from("/org/a11y/atspi/accessible/root").map_err(internal)?,
        );
        let root = self.proxy(&registry, "Accessible").await?;
        let count: i32 = root.get_property("ChildCount").await.map_err(internal)?;
        let dbus = zbus::fdo::DBusProxy::new(&self.conn)
            .await
            .map_err(internal)?;
        for index in 0..count.clamp(0, 256) {
            let app: Object = root
                .call("GetChildAtIndex", &(index,))
                .await
                .map_err(internal)?;
            let app_pid = dbus
                .get_connection_unix_process_id(app.0.as_str().try_into().map_err(internal)?)
                .await;
            if app_pid.ok() != Some(pid) {
                continue;
            }
            let accessible = self.proxy(&app, "Accessible").await?;
            let windows: i32 = accessible
                .get_property("ChildCount")
                .await
                .map_err(internal)?;
            for i in 0..windows.clamp(0, 256) {
                let window: Object = accessible
                    .call("GetChildAtIndex", &(i,))
                    .await
                    .map_err(internal)?;
                let component = self.proxy(&window, "Component").await?;
                if let Ok((x, y, w, h)) = component
                    .call::<_, _, (i32, i32, i32, i32)>("GetExtents", &(0u32,))
                    .await
                {
                    // WM frame decorations may surround the content window.
                    if x <= bounds.x
                        && y <= bounds.y
                        && x + w >= bounds.x + bounds.w
                        && y + h >= bounds.y + bounds.h
                        && (x - bounds.x).abs() < 128
                        && (y - bounds.y).abs() < 128
                    {
                        self.scope = Some(window);
                        return Ok(());
                    }
                }
            }
            return Err(Fault::new(
                "target_gone",
                "AT-SPI window does not match target bounds",
            ));
        }
        Err(Fault::new(
            "not_supported",
            "Application has no AT-SPI accessibility tree",
        ))
    }
    pub fn clear(&mut self) {
        self.scope = None;
        self.refs.clear();
    }
    fn remember(&mut self, object: &Object) -> String {
        self.refs
            .retain(format!("{}{}", object.0, object.1), object.clone())
    }
    pub(crate) async fn node(&mut self, object: &Object) -> Result<(Node, i32, bool)> {
        self.fence_refs(object).await?;
        let result = self.read_node(object).await;
        // A disappeared object may fail before it can return a Defunct state.
        // Retire on lost continuity, including a failed fresh property read.
        if result.is_err() { self.refs.remove(&format!("{}{}", object.0, object.1)); }
        result
    }
    async fn read_node(&mut self, object: &Object) -> Result<(Node, i32, bool)> {
        let generation = self.lifecycle_generation;
        let a = self.proxy(object, "Accessible").await?;
        let name: String = a
            .get_property("Name")
            .await
            .map_err(|e| Fault::new("target_gone", e.to_string()))?;
        let role: String = a.call("GetRoleName", &()).await.map_err(internal)?;
        let description: String = a.get_property("Description").await.unwrap_or_default();
        let count: i32 = a.get_property("ChildCount").await.unwrap_or(0);
        let states: StateSet = a.call("GetState", &()).await.map_err(internal)?;
        if states.contains(State::Defunct) {
            self.refs.remove(&format!("{}{}", object.0, object.1));
            return Err(Fault::new(
                "target_gone",
                "Accessibility element was destroyed",
            ));
        }
        let mut truncated = false;
        let interfaces: Vec<String> = a.call("GetInterfaces", &()).await.unwrap_or_default();
        let has = |s: &str| interfaces.iter().any(|i| i.ends_with(s));
        let mut actions = Vec::new();
        if has("Action") {
            let p = self.proxy(object, "Action").await?;
            let n: i32 = p.get_property("NActions").await.unwrap_or(0);
            for i in 0..n.clamp(0, 32) {
                let name: String = p.call("GetName", &(i,)).await.unwrap_or_default();
                if let Some(action) = semantic(&name) {
                    if !actions.iter().any(|a| a == action) {
                        actions.push(action.to_owned());
                    }
                }
            }
        }
        if has("Component") && states.contains(State::Focusable) {
            actions.push("focus".into());
        }
        if has("Component") && role == "scroll bar" {
            actions.push("scroll".into());
        }
        if has("EditableText") && states.contains(State::Editable) {
            actions.push("setValue".into());
        }
        let mut value = None;
        if has("Text") && role != "password text" {
            let text = self.proxy(object, "Text").await?;
            let length: i32 = text.get_property("CharacterCount").await.unwrap_or(0);
            truncated |= length > 512;
            value = text
                .call::<_, _, String>("GetText", &(0i32, length.clamp(0, 512)))
                .await
                .ok();
        }
        let mut bounds = Bounds::default();
        if has("Component") {
            let c = self.proxy(object, "Component").await?;
            if let Ok((x, y, w, h)) = c
                .call::<_, _, (i32, i32, i32, i32)>("GetExtents", &(0u32,))
                .await
            {
                bounds = Bounds {
                    x,
                    y,
                    w: w.max(0),
                    h: h.max(0),
                };
            }
        }
        let mut mapped = Vec::new();
        for (state, label) in [
            (State::Focused, "focused"),
            (State::Selected, "selected"),
            (State::Checked, "checked"),
            (State::Expanded, "expanded"),
        ] {
            if states.contains(state) {
                mapped.push(label.into());
            }
        }
        if !states.contains(State::Enabled) || !states.contains(State::Sensitive) {
            mapped.push("disabled".into());
        }
        if !states.contains(State::Showing) {
            mapped.push("offscreen".into());
        }
        self.fence_refs(object).await?;
        if generation != self.lifecycle_generation { return Err(Fault::new("busy", "Accessibility element changed during observation")); }
        let reference = self.remember(object);
        let mut node = Node {
            reference,
            role,
            name,
            value,
            description,
            bounds,
            states: mapped,
            actions,
            children: Vec::new(),
        };
        truncated |= bound_node(&mut node);
        Ok((node, count.max(0), truncated))
    }
    pub async fn tree(&mut self, depth: usize, nodes: usize) -> Result<Value> {
        let mut budget = crate::traversal::Budget::new(depth, nodes)?;
        let root = self
            .scope
            .clone()
            .ok_or_else(|| Fault::new("target_gone", "No accessibility target"))?;
        self.fence_refs(&root).await?;
        let generation = self.lifecycle_generation;
        let mut seen = HashSet::new();
        let tree = self
            .branch(root.clone(), 0, &mut budget, &mut seen)
            .await?
            .ok_or_else(|| Fault::new("bounds", "Root exceeds reply byte cap"))?;
        self.fence_refs(&root).await?;
        if generation != self.lifecycle_generation { return Err(Fault::new("busy", "Accessibility tree changed during observation")); }
        Ok(json!({"tree":tree,"truncated":budget.truncated}))
    }
    fn branch<'a>(
        &'a mut self,
        object: Object,
        level: usize,
        budget: &'a mut crate::traversal::Budget,
        seen: &'a mut HashSet<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Node>>> + 'a>> {
        Box::pin(async move {
            let (mut node, count, clipped) = self.node(&object).await?;
            budget.truncated |= clipped;
            // Charge only this node once, not its accumulating descendants.
            if !budget.admit(serde_json::to_vec(&node).map_err(internal)?.len() + 1) {
                return Ok(None);
            }
            seen.insert(format!("{}{}", object.0, object.1));
            for index in 0..count {
                if !budget.descend(level, (count - index) as usize) {
                    break;
                }
                let a = self.proxy(&object, "Accessible").await?;
                let child: Object = a
                    .call("GetChildAtIndex", &(index,))
                    .await
                    .map_err(internal)?;
                if seen.contains(&format!("{}{}", child.0, child.1)) {
                    budget.truncated = true;
                    continue;
                }
                match self.branch(child, level + 1, budget, seen).await? {
                    Some(child) => node.children.push(child),
                    None => break,
                }
            }
            Ok(Some(node))
        })
    }
    pub async fn find(&mut self, query: &Query, limit: usize) -> Result<Value> {
        if !(1..=128).contains(&limit) {
            return Err(Fault::new("bounds", "Find limit must be 1..128"));
        }
        let root = self
            .scope
            .clone()
            .ok_or_else(|| Fault::new("target_gone", "No accessibility target"))?;
        self.fence_refs(&root).await?;
        let generation = self.lifecycle_generation;
        let mut stack = vec![(root.clone(), 0usize)];
        let mut visited = HashSet::new();
        let mut found = Vec::new();
        let mut reply_bytes = 0usize;
        let mut truncated = false;
        while let Some((object, depth)) = stack.pop() {
            let key = format!("{}{}", object.0, object.1);
            if !visited.insert(key) {
                continue;
            }
            let (node, count, clipped) = self.node(&object).await?;
            truncated |= clipped;
            if matches(query, &node) {
                let bytes = serde_json::to_vec(&node).map_err(internal)?.len() + 1;
                if reply_bytes + bytes > 60 * 1024 {
                    truncated = true;
                    break;
                }
                reply_bytes += bytes;
                found.push(node);
                if found.len() == limit {
                    truncated |= count > 0 || !stack.is_empty();
                    break;
                }
            }
            if visited.len() >= 512 {
                truncated = true;
                break;
            }
            if depth >= 32 {
                truncated |= count > 0;
                continue;
            }
            let a = self.proxy(&object, "Accessible").await?;
            let capacity = 512usize.saturating_sub(visited.len() + stack.len());
            truncated |= count as usize > capacity;
            for index in (0..count.min(capacity as i32)).rev() {
                let child: Object = a
                    .call("GetChildAtIndex", &(index,))
                    .await
                    .map_err(internal)?;
                stack.push((child, depth + 1));
            }
        }
        self.fence_refs(&root).await?;
        if generation != self.lifecycle_generation { return Err(Fault::new("busy", "Accessibility tree changed during observation")); }
        Ok(json!({"nodes":found,"truncated":truncated}))
    }
}

/// Return whether any field was clipped, using the shared schema's scalar counts.
pub fn bound_node(node: &mut Node) -> bool {
    fn bound(value: &mut String, cap: usize) -> bool {
        let mut scalars = value.char_indices();
        if let Some((end, _)) = scalars.nth(cap) {
            value.truncate(end);
            true
        } else {
            false
        }
    }
    let mut clipped = bound(&mut node.role, 128);
    clipped |= bound(&mut node.name, 256);
    clipped |= bound(&mut node.description, 256);
    if let Some(value) = &mut node.value {
        clipped |= bound(value, 512);
    }
    clipped
}
pub fn semantic(name: &str) -> Option<&'static str> {
    match name.to_lowercase().as_str() {
        "click" | "press" | "activate" => Some("press"),
        "expand" | "open" => Some("expand"),
        "select" => Some("select"),
        _ => None,
    }
}
pub fn matches(q: &Query, n: &Node) -> bool {
    q.role.as_ref().is_none_or(|r| n.role == *r)
        && q.name
            .as_ref()
            .is_none_or(|s| n.name.to_lowercase().contains(&s.to_lowercase()))
        && q.text.as_ref().is_none_or(|s| {
            n.value
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .contains(&s.to_lowercase())
        })
}

#[cfg(test)]
#[path = "accessibility_tests.rs"]
mod tests;
