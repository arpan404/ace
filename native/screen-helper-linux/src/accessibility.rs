//! Accessibility I/O. Ref cache stores identity only; properties are read fresh.
use crate::protocol::{Fault, Query, Result, internal};
use atspi::{State, StateSet};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
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
    pub(crate) refs: HashMap<String, Object>,
    order: VecDeque<String>,
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
        Ok(Self {
            conn,
            refs: HashMap::new(),
            order: VecDeque::new(),
            scope: None,
        })
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
    pub(crate) async fn proxy<'a>(
        &'a self,
        object: &'a Object,
        interface: &str,
    ) -> Result<Proxy<'a>> {
        Proxy::new(
            &self.conn,
            object.0.as_str(),
            object.1.as_str(),
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
        self.order.clear();
    }
    fn remember(&mut self, object: &Object) -> String {
        let key = format!("{}{}", object.0, object.1);
        if !self.refs.contains_key(&key) {
            if self.refs.len() >= 4096 {
                if let Some(old) = self.order.pop_front() {
                    self.refs.remove(&old);
                }
            }
            self.order.push_back(key.clone());
            self.refs.insert(key.clone(), object.clone());
        }
        key
    }
    pub(crate) async fn node(&mut self, object: &Object) -> Result<(Node, i32)> {
        let reference = self.remember(object);
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
            return Err(Fault::new(
                "target_gone",
                "Accessibility element was destroyed",
            ));
        }
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
            value = text
                .call::<_, _, String>("GetText", &(0i32, length.clamp(0, 1024)))
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
        Ok((
            Node {
                reference,
                role,
                name: clipped(&name),
                value: value.map(|s| clipped(&s)),
                description: clipped(&description),
                bounds,
                states: mapped,
                actions,
                children: Vec::new(),
            },
            count.max(0),
        ))
    }
    pub async fn tree(&mut self, depth: usize, nodes: usize) -> Result<Value> {
        let mut budget = crate::traversal::Budget::new(depth, nodes)?;
        let root = self
            .scope
            .clone()
            .ok_or_else(|| Fault::new("target_gone", "No accessibility target"))?;
        let mut seen = HashSet::new();
        let tree = self
            .branch(root, 0, &mut budget, &mut seen)
            .await?
            .ok_or_else(|| Fault::new("bounds", "Root exceeds reply byte cap"))?;
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
            let (mut node, count) = self.node(&object).await?;
            // Charge only this node once, not its accumulating descendants.
            if !budget.admit(serde_json::to_vec(&node).map_err(internal)?.len() + 1) {
                return Ok(None);
            }
            seen.insert(node.reference.clone());
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
        let mut stack = vec![(root, 0usize)];
        let mut visited = HashSet::new();
        let mut found = Vec::new();
        let mut reply_bytes = 0usize;
        let mut truncated = false;
        while let Some((object, depth)) = stack.pop() {
            let key = format!("{}{}", object.0, object.1);
            if !visited.insert(key) {
                continue;
            }
            let (node, count) = self.node(&object).await?;
            if matches(query, &node) {
                let bytes = serde_json::to_vec(&node).map_err(internal)?.len() + 1;
                if reply_bytes + bytes > 60 * 1024 {
                    truncated = true;
                    break;
                }
                reply_bytes += bytes;
                found.push(node);
                if found.len() == limit {
                    truncated = count > 0 || !stack.is_empty();
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
        Ok(json!({"nodes":found,"truncated":truncated}))
    }
}

fn clipped(s: &str) -> String {
    s.chars().take(1024).collect()
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
