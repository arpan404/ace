// SPDX-License-Identifier: Apache-2.0
//! Where a resource sits (ADR 0209 §4.2): every thread-scoped resource resolves to one tree's
//! root, and that root to its access. This is the seam the access table fills; until it does, no
//! tree has access a member can hold, so every member request on a tree is refused.

/// What names something inside a tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeRef {
    Thread(String),
    Interaction(String),
    Task(String),
    /// A handle bound to its root when it was made: never re-derived from a later id.
    Root(String),
}

/// Who may reach a tree through ace (ADR 0209 §5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Org,
    Members,
    Private,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeAccess {
    pub owner: String,
    pub visibility: Visibility,
    /// For `members`: the accounts it is shared with.
    pub readers: Vec<String>,
}

impl TreeAccess {
    pub fn private(owner: impl Into<String>) -> Self {
        Self {
            owner: owner.into(),
            visibility: Visibility::Private,
            readers: Vec::new(),
        }
    }
}

/// Where a resource sits, and who may reach its tree.
pub trait TreeResolver {
    /// The root of the tree `reference` is in, or `None` when it can't be placed.
    fn root(&self, reference: &TreeRef) -> Option<String>;
    /// That root's owner and visibility, or `None` when it has none a member can hold.
    fn access(&self, root: &str) -> Option<TreeAccess>;
}

/// How a thread in a delegation tree finds its root.
type RootOf = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Part A's resolver: places threads by their delegation tree and handles by their bound root,
/// and knows no tree's access, so every member request on a tree is refused.
pub struct StructuralTrees {
    root_of: RootOf,
}

impl StructuralTrees {
    pub fn new(root_of: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Self {
        Self {
            root_of: Box::new(root_of),
        }
    }
}

impl TreeResolver for StructuralTrees {
    fn root(&self, reference: &TreeRef) -> Option<String> {
        match reference {
            TreeRef::Root(root) => Some(root.clone()),
            TreeRef::Thread(thread) => {
                Some((self.root_of)(thread).unwrap_or_else(|| thread.clone()))
            }
            TreeRef::Interaction(_) | TreeRef::Task(_) => None,
        }
    }

    fn access(&self, _root: &str) -> Option<TreeAccess> {
        None
    }
}
