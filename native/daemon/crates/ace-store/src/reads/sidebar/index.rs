// SPDX-License-Identifier: Apache-2.0
//! Incremental in-memory sidebar index (`sidebar-index.ts`, PR #2737 `withChats` rules).
//!
//! Keeps every thread's sidebar membership and order sorted by SQLite's exact storage-class and
//! BINARY UTF-8 code-point rules (`ORDER BY key DESC, id ASC`). A project window with
//! `with_chats: true` merges the project's list and the chats list reading at most `limit` from
//! each, deduplicating a chat's own project so `total` and `page` match the SQL path exactly.

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, HashSet};

use crate::Value as SqlValue;

/// One thread's sidebar facts, exactly as the sidebar SQL expressions evaluate them.
#[derive(Debug, Clone, PartialEq)]
pub struct SidebarFacts {
    pub id: String,
    pub revision: u64,
    pub workspace: SqlValue,
    pub deleted: bool,
    pub archived: bool,
    /// In a chat's hidden project (ADR 0099): shown in every project's window when `with_chats`.
    pub chat: bool,
    /// `Some(true)` = paged, `Some(false)` = active, `None` = neither.
    pub settled: Option<bool>,
    /// Counted in its project's total (not an unsent draft or paired-machine delegated thread).
    pub counted: bool,
    pub activity: SqlValue,
    pub archived_at: SqlValue,
}

/// Filter scope for a sidebar window (`SidebarScope`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SidebarScope {
    pub project: Option<String>,
    pub archived: bool,
    /// Carry every chat in a project's window (PR #2737 / ADR 0099). Only the app's own
    /// sidebar subscription sets this; external MCP and strict project callers keep it false.
    pub with_chats: bool,
}

/// One workspace's thread count (`{ id, threads }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarCount {
    pub id: String,
    pub threads: usize,
}

/// Window membership computed by [`SidebarIndex::window`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarWindowIds {
    /// Live threads, all of them, newest first. Empty for the archive.
    pub active: Vec<String>,
    /// The first `limit` paged threads, newest first.
    pub page: Vec<String>,
    pub more: bool,
    pub total: usize,
    pub counts: Vec<SidebarCount>,
}

/// Sort key matching `ORDER BY key DESC, id ASC` over raw SQLite values.
#[derive(Debug, Clone)]
struct SortKey {
    key: SqlValue,
    id: String,
}

impl PartialEq for SortKey {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for SortKey {}

impl PartialOrd for SortKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SortKey {
    fn cmp(&self, other: &Self) -> Ordering {
        compare_sql(&other.key, &self.key).then_with(|| self.id.as_bytes().cmp(other.id.as_bytes()))
    }
}

#[derive(Debug, Clone, Copy)]
enum KeyKind {
    Activity,
    ArchivedAt,
}

impl KeyKind {
    fn extract(self, facts: &SidebarFacts) -> SortKey {
        SortKey {
            key: match self {
                KeyKind::Activity => facts.activity.clone(),
                KeyKind::ArchivedAt => facts.archived_at.clone(),
            },
            id: facts.id.clone(),
        }
    }
}

#[derive(Debug)]
struct Lists {
    kind: KeyKind,
    all: BTreeSet<SortKey>,
    chats: BTreeSet<SortKey>,
    projects: HashMap<String, BTreeSet<SortKey>>,
    /// Members of `chats` per workspace: the overlap a project's window has with `chats`.
    chat_members: HashMap<String, usize>,
}

impl Lists {
    fn new(kind: KeyKind) -> Self {
        Self {
            kind,
            all: BTreeSet::new(),
            chats: BTreeSet::new(),
            projects: HashMap::new(),
            chat_members: HashMap::new(),
        }
    }

    fn insert(&mut self, facts: &SidebarFacts) {
        let key = self.kind.extract(facts);
        self.all.insert(key.clone());
        if let SqlValue::Text(ref ws) = facts.workspace {
            self.projects
                .entry(ws.clone())
                .or_default()
                .insert(key.clone());
        }
        if facts.chat {
            self.chats.insert(key);
            if let SqlValue::Text(ref ws) = facts.workspace {
                *self.chat_members.entry(ws.clone()).or_insert(0) += 1;
            }
        }
    }

    fn remove(&mut self, facts: &SidebarFacts) {
        let key = self.kind.extract(facts);
        self.all.remove(&key);
        if let SqlValue::Text(ref ws) = facts.workspace
            && let Some(set) = self.projects.get_mut(ws)
        {
            set.remove(&key);
            if set.is_empty() {
                self.projects.remove(ws);
            }
        }
        if facts.chat {
            self.chats.remove(&key);
            if let SqlValue::Text(ref ws) = facts.workspace
                && let Some(count) = self.chat_members.get_mut(ws)
            {
                if *count <= 1 {
                    self.chat_members.remove(ws);
                } else {
                    *count -= 1;
                }
            }
        }
    }

    fn clear(&mut self) {
        self.all.clear();
        self.chats.clear();
        self.projects.clear();
        self.chat_members.clear();
    }

    fn chats_in(&self, workspace: &str) -> usize {
        self.chat_members.get(workspace).copied().unwrap_or(0)
    }

    fn window(&self, project: Option<&str>, with_chats: bool, limit: usize) -> (Vec<String>, usize) {
        let Some(project) = project else {
            let ids = self
                .all
                .iter()
                .take(limit)
                .map(|k| k.id.clone())
                .collect();
            return (ids, self.all.len());
        };
        let own = self.projects.get(project);
        if !with_chats {
            let ids = own
                .map(|set| set.iter().take(limit).map(|k| k.id.clone()).collect())
                .unwrap_or_default();
            return (ids, own.map_or(0, BTreeSet::len));
        }
        let total = own.map_or(0, BTreeSet::len) + self.chats.len() - self.chats_in(project);
        let ids = merge_first(own, &self.chats, limit);
        (ids, total)
    }
}

/// Merge the first `limit` items from two `BTreeSet<SortKey>` lists, deduplicating by `id`,
/// touching at most `limit` items from each list (O(limit), never history-sized).
fn merge_first(
    one: Option<&BTreeSet<SortKey>>,
    other: &BTreeSet<SortKey>,
    limit: usize,
) -> Vec<String> {
    let Some(one) = one else {
        return other.iter().take(limit).map(|k| k.id.clone()).collect();
    };
    let left: Vec<&SortKey> = one.iter().take(limit).collect();
    let right: Vec<&SortKey> = other.iter().take(limit).collect();
    let mut seen: HashSet<&str> = HashSet::with_capacity(limit);
    let mut merged: Vec<String> = Vec::with_capacity(limit.min(left.len() + right.len()));
    let mut i = 0;
    let mut j = 0;
    while merged.len() < limit && (i < left.len() || j < right.len()) {
        let next = match (left.get(i), right.get(j)) {
            (Some(a), Some(b)) if *a <= *b => {
                i += 1;
                *a
            }
            (Some(_), Some(b)) => {
                j += 1;
                *b
            }
            (Some(a), None) => {
                i += 1;
                *a
            }
            (None, Some(b)) => {
                j += 1;
                *b
            }
            (None, None) => break,
        };
        if seen.insert(next.id.as_str()) {
            merged.push(next.id.clone());
        }
    }
    merged
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum CountKey {
    Null,
    Int(i64),
    Real(u64),
    Text(String),
    Blob(Vec<u8>),
}

impl CountKey {
    fn from_sql(val: &SqlValue) -> Self {
        match val {
            SqlValue::Null => CountKey::Null,
            SqlValue::Integer(n) => CountKey::Int(*n),
            SqlValue::Real(f) => CountKey::Real(if *f == 0.0 { 0.0_f64.to_bits() } else { f.to_bits() }),
            SqlValue::Text(s) => CountKey::Text(s.clone()),
            SqlValue::Blob(b) => CountKey::Blob(b.clone()),
        }
    }
}

#[derive(Debug, Default)]
struct Counts {
    map: HashMap<CountKey, (SqlValue, usize)>,
}

impl Counts {
    fn add(&mut self, workspace: &SqlValue, delta: isize) {
        let key = CountKey::from_sql(workspace);
        if let Some((_, count)) = self.map.get_mut(&key) {
            let next = (*count as isize) + delta;
            if next > 0 {
                *count = next as usize;
            } else {
                self.map.remove(&key);
            }
        } else if delta > 0 {
            self.map.insert(key, (workspace.clone(), delta as usize));
        }
    }

    fn sorted_counts(&self) -> Vec<SidebarCount> {
        let mut entries: Vec<(&SqlValue, usize)> =
            self.map.values().map(|(ws, n)| (ws, *n)).collect();
        entries.sort_by(|(a, _), (b, _)| compare_sql(a, b));
        entries
            .into_iter()
            .map(|(ws, threads)| SidebarCount {
                id: sql_to_js_string(ws),
                threads,
            })
            .collect()
    }

    fn clear(&mut self) {
        self.map.clear();
    }
}

/// Incremental sorted index over every thread's sidebar facts (`SidebarIndex`).
#[derive(Debug)]
pub struct SidebarIndex {
    facts: HashMap<String, SidebarFacts>,
    paged: Lists,
    active: Lists,
    archived: Lists,
    live_counts: Counts,
    archived_counts: Counts,
}

impl Default for SidebarIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl SidebarIndex {
    pub fn new() -> Self {
        Self {
            facts: HashMap::new(),
            paged: Lists::new(KeyKind::Activity),
            active: Lists::new(KeyKind::Activity),
            archived: Lists::new(KeyKind::ArchivedAt),
            live_counts: Counts::default(),
            archived_counts: Counts::default(),
        }
    }

    pub fn revision(&self, id: &str) -> Option<u64> {
        self.facts.get(id).map(|f| f.revision)
    }

    /// Replace everything with `all`. Returns `Err` if any thread id is duplicated.
    pub fn load(&mut self, all: impl IntoIterator<Item = SidebarFacts>) -> Result<(), &'static str> {
        self.clear();
        for facts in all {
            if self.facts.contains_key(&facts.id) {
                return Err("Sidebar facts repeat a thread");
            }
            self.insert_into_lists(&facts);
            self.adjust_count(&facts, 1);
            self.facts.insert(facts.id.clone(), facts);
        }
        Ok(())
    }

    /// Insert or replace one thread's facts.
    pub fn put(&mut self, facts: SidebarFacts) {
        self.remove(&facts.id);
        self.insert_into_lists(&facts);
        self.adjust_count(&facts, 1);
        self.facts.insert(facts.id.clone(), facts);
    }

    /// Remove a thread's facts if present.
    pub fn remove(&mut self, id: &str) {
        let Some(old) = self.facts.remove(id) else {
            return;
        };
        self.remove_from_lists(&old);
        self.adjust_count(&old, -1);
    }

    pub fn clear(&mut self) {
        self.facts.clear();
        self.paged.clear();
        self.active.clear();
        self.archived.clear();
        self.live_counts.clear();
        self.archived_counts.clear();
    }

    /// Compute the sidebar window for `scope` and `limit`.
    pub fn window(&self, scope: &SidebarScope, limit: usize) -> SidebarWindowIds {
        let project = scope.project.as_deref();
        let (page, total) = if scope.archived {
            self.archived.window(project, scope.with_chats, limit)
        } else {
            self.paged.window(project, scope.with_chats, limit)
        };
        let active = if scope.archived {
            Vec::new()
        } else {
            self.active.window(project, scope.with_chats, usize::MAX).0
        };
        let counts = if scope.archived {
            self.archived_counts.sorted_counts()
        } else {
            self.live_counts.sorted_counts()
        };
        SidebarWindowIds {
            active,
            page,
            more: total > limit,
            total,
            counts,
        }
    }

    fn insert_into_lists(&mut self, facts: &SidebarFacts) {
        if facts.deleted {
            return;
        }
        if facts.archived {
            self.archived.insert(facts);
        } else if facts.settled == Some(true) {
            self.paged.insert(facts);
        } else if facts.settled == Some(false) {
            self.active.insert(facts);
        }
    }

    fn remove_from_lists(&mut self, facts: &SidebarFacts) {
        if facts.deleted {
            return;
        }
        if facts.archived {
            self.archived.remove(facts);
        } else if facts.settled == Some(true) {
            self.paged.remove(facts);
        } else if facts.settled == Some(false) {
            self.active.remove(facts);
        }
    }

    fn adjust_count(&mut self, facts: &SidebarFacts, delta: isize) {
        if !facts.deleted && facts.counted {
            if facts.archived {
                self.archived_counts.add(&facts.workspace, delta);
            } else {
                self.live_counts.add(&facts.workspace, delta);
            }
        }
    }
}

/// SQLite's default ordering: NULL, then numbers by value, then text by UTF-8/code-point order,
/// then blobs (`compareSql`).
pub fn compare_sql(a: &SqlValue, b: &SqlValue) -> Ordering {
    storage_class(a)
        .cmp(&storage_class(b))
        .then_with(|| match (a, b) {
            (SqlValue::Null, SqlValue::Null) => Ordering::Equal,
            (SqlValue::Integer(x), SqlValue::Integer(y)) => x.cmp(y),
            (SqlValue::Integer(x), SqlValue::Real(y)) => compare_int_real(*x, *y),
            (SqlValue::Real(x), SqlValue::Integer(y)) => compare_int_real(*y, *x).reverse(),
            (SqlValue::Real(x), SqlValue::Real(y)) => x.total_cmp(y),
            (SqlValue::Text(x), SqlValue::Text(y)) => x.as_bytes().cmp(y.as_bytes()),
            (SqlValue::Blob(x), SqlValue::Blob(y)) => x.cmp(y),
            _ => Ordering::Equal,
        })
}

fn storage_class(v: &SqlValue) -> u8 {
    match v {
        SqlValue::Null => 0,
        SqlValue::Integer(_) | SqlValue::Real(_) => 1,
        SqlValue::Text(_) => 2,
        SqlValue::Blob(_) => 3,
    }
}

fn compare_int_real(i: i64, f: f64) -> Ordering {
    if f.is_nan() {
        return Ordering::Greater;
    }
    // f64 represents all integers up to 2^53 exactly; compare against bounds for full precision.
    if f < (i64::MIN as f64) {
        return Ordering::Greater;
    }
    if f >= 9_223_372_036_854_775_808.0_f64 {
        return Ordering::Less;
    }
    let trunc = f.trunc() as i64;
    match i.cmp(&trunc) {
        Ordering::Equal => 0.0_f64.total_cmp(&f.fract()),
        other => other,
    }
}

pub(crate) fn sql_to_js_string(v: &SqlValue) -> String {
    match v {
        SqlValue::Null => "null".to_owned(),
        SqlValue::Integer(n) => n.to_string(),
        SqlValue::Real(f) => f.to_string(),
        SqlValue::Text(s) => s.clone(),
        SqlValue::Blob(b) => String::from_utf8_lossy(b).into_owned(),
    }
}
