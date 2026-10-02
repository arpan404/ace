use crate::{
    coordinates::Bounds,
    errors::{Code, Error, Result},
};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub r#ref: String,
    pub role: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub bounds: Bounds,
    pub states: Vec<String>,
    pub actions: Vec<String>,
    pub children: Vec<Node>,
}
#[derive(Debug, Serialize)]
pub struct Tree {
    pub root: Option<Node>,
    pub truncated: bool,
}
#[derive(Debug, Deserialize)]
pub struct Query {
    pub role: Option<String>,
    pub name: Option<String>,
    pub text: Option<String>,
}
impl Query {
    pub fn matches(&self, node: &Node) -> bool {
        self.role
            .as_ref()
            .is_none_or(|v| node.role.eq_ignore_ascii_case(v))
            && self
                .name
                .as_ref()
                .is_none_or(|v| node.name.to_lowercase().contains(&v.to_lowercase()))
            && self.text.as_ref().is_none_or(|v| {
                node.name.to_lowercase().contains(&v.to_lowercase())
                    || node
                        .value
                        .as_ref()
                        .is_some_and(|s| s.to_lowercase().contains(&v.to_lowercase()))
            })
    }
}
/// Fetch one element and its cached properties at a time. Never ask a provider for an unbounded subtree.
pub trait Source {
    type Element: Clone;
    fn node(&mut self, element: &Self::Element) -> Result<Node>;
    fn first_child(&mut self, element: &Self::Element) -> Result<Option<Self::Element>>;
    fn next_sibling(&mut self, element: &Self::Element) -> Result<Option<Self::Element>>;
}
struct Budget {
    remaining: usize,
    depth: usize,
    bytes: usize,
    truncated: bool,
}
impl Budget {
    fn accept(&mut self, node: &Node) -> Result<bool> {
        // Serialize only this flat node, never a subtree or history, to count escaping exactly.
        let size = serde_json::to_vec(node)
            .map_err(|e| Error::new(Code::Internal, e.to_string()))?
            .len()
            + 1;
        if size > self.bytes {
            self.truncated = true;
            self.remaining = 0;
            return Ok(false);
        }
        self.bytes -= size;
        Ok(true)
    }
}
pub fn walk<S: Source>(
    source: &mut S,
    root: S::Element,
    max_depth: usize,
    max_nodes: usize,
) -> Result<Tree> {
    if max_nodes == 0 || max_nodes > 2048 || max_depth > 32 {
        return Err(Error::new(Code::Bounds, "Tree caps exceeded"));
    }
    let mut budget = Budget {
        remaining: max_nodes,
        depth: max_depth,
        bytes: crate::codec::MAX_REPLY - 4096,
        truncated: false,
    };
    let root = visit(source, &root, 0, &mut budget)?;
    Ok(Tree {
        root,
        truncated: budget.truncated,
    })
}
fn visit<S: Source>(
    source: &mut S,
    element: &S::Element,
    depth: usize,
    budget: &mut Budget,
) -> Result<Option<Node>> {
    if budget.remaining == 0 {
        budget.truncated = true;
        return Ok(None);
    }
    budget.remaining -= 1;
    let node = source.node(element)?;
    let Some(mut node) = prune(node) else {
        return Ok(None);
    };
    if !budget.accept(&node)? {
        return Ok(None);
    }
    let mut child = source.first_child(element)?;
    if depth == budget.depth {
        budget.truncated |= child.is_some();
        return Ok(Some(node));
    }
    while let Some(element) = child {
        if budget.remaining == 0 {
            budget.truncated = true;
            break;
        }
        if let Some(child_node) = visit(source, &element, depth + 1, budget)? {
            node.children.push(child_node);
        }
        child = source.next_sibling(&element)?;
    }
    Ok(Some(node))
}
pub fn find(tree: &Tree, query: &Query, limit: usize) -> Result<Vec<Node>> {
    if limit == 0 || limit > 128 {
        return Err(Error::new(Code::Bounds, "Find limit exceeded"));
    }
    let mut result = Vec::new();
    if let Some(root) = &tree.root {
        search(root, query, limit, &mut result);
    }
    Ok(result)
}
fn search(node: &Node, query: &Query, limit: usize, result: &mut Vec<Node>) {
    if result.len() >= limit {
        return;
    }
    if query.matches(node) {
        let mut found = node.clone();
        found.children.clear();
        result.push(found);
    }
    for child in &node.children {
        search(child, query, limit, result);
        if result.len() == limit {
            break;
        }
    }
}

fn prune(mut node: Node) -> Option<Node> {
    node.name = limited(node.name);
    node.value = node.value.map(limited);
    node.description = node.description.map(limited);
    node.children.clear();
    if node.states.iter().any(|s| s == "offscreen") {
        None
    } else {
        Some(node)
    }
}
#[derive(Debug, Serialize)]
pub struct Found {
    pub nodes: Vec<Node>,
    pub truncated: bool,
}
pub fn find_from<S: Source>(
    source: &mut S,
    root: S::Element,
    query: &Query,
    limit: usize,
) -> Result<Found> {
    if limit == 0 || limit > 128 {
        return Err(Error::new(Code::Bounds, "Find limit exceeded"));
    }
    let mut budget = Budget {
        remaining: 2048,
        depth: 32,
        bytes: crate::codec::MAX_REPLY - 4096,
        truncated: false,
    };
    let mut result = Vec::new();
    visit_matches(source, &root, 0, &mut budget, query, limit, &mut result)?;
    Ok(Found {
        nodes: result,
        truncated: budget.truncated,
    })
}
fn visit_matches<S: Source>(
    source: &mut S,
    element: &S::Element,
    depth: usize,
    budget: &mut Budget,
    query: &Query,
    limit: usize,
    result: &mut Vec<Node>,
) -> Result<()> {
    if budget.remaining == 0 || result.len() == limit {
        budget.truncated = true;
        return Ok(());
    }
    budget.remaining -= 1;
    let Some(node) = prune(source.node(element)?) else {
        return Ok(());
    };
    if !budget.accept(&node)? {
        return Ok(());
    }
    if query.matches(&node) {
        result.push(node);
    }
    if result.len() == limit {
        budget.truncated = true;
        return Ok(());
    }
    let mut child = source.first_child(element)?;
    if depth == budget.depth {
        budget.truncated |= child.is_some();
        return Ok(());
    }
    while let Some(element) = child {
        if budget.remaining == 0 || result.len() == limit {
            budget.truncated = true;
            break;
        }
        visit_matches(source, &element, depth + 1, budget, query, limit, result)?;
        child = source.next_sibling(&element)?;
    }
    Ok(())
}

fn limited(value: String) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 256
        })
        .collect()
}
