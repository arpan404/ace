// SPDX-License-Identifier: Apache-2.0
//! Sidebar read model to the wire (T4): ports `sidebar-reads.ts`, `sidebar-index.ts`,
//! `sidebar-live.ts`, `sidebar-page-storage.ts`, `sidebar-facts.ts`, `sidebar-columns.ts`,
//! and `sidebar-revisions.ts`, including PR #2737 `withChats` rules.

pub mod facts;
pub mod index;
pub mod live;
pub mod storage;

use std::sync::Arc;

pub use facts::{
    SIDEBAR_ACTIVITY, SIDEBAR_COUNTED, SIDEBAR_DELETED, SIDEBAR_READABLE, SIDEBAR_REMOVAL_LOG,
    bump_workspace_chat_revisions, open_sidebar_columns, open_sidebar_revisions,
    sidebar_columns_readable, sidebar_epoch, sidebar_fact_columns_sql, sidebar_settled_sql,
};
pub use index::{
    SidebarCount, SidebarFacts, SidebarIndex, SidebarScope, SidebarWindowIds, compare_sql,
};
pub use live::{SidebarError, SidebarLive};
pub use storage::{
    PageReuse, SidebarCursor, SidebarEntry, SidebarPageResult, SidebarWindowMeta, sidebar_cursor,
    sidebar_page_storage,
};

use crate::Connection;
use crate::reads::sidebar::storage::read_full_entry;

/// Stateful sidebar reader combining the incremental live index (`SidebarLive`) with SQLite
/// page storage (`sidebar_page_storage`), matching `SidebarReads` in `sidebar-reads.ts`.
#[derive(Debug, Default)]
pub struct SidebarReads {
    live: SidebarLive,
}

impl SidebarReads {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset_live(&mut self) {
        self.live.reset();
    }

    /// Read a sidebar page for `scope` and `limit`.
    ///
    /// When `reuse` is provided, `before` is `None`, and `committed` is true (no open write
    /// transaction that could roll back), reads through the incremental [`SidebarLive`] index
    /// so cost is proportional to changed rows + `limit`. Otherwise runs the SQL page query.
    pub fn sidebar_page(
        &mut self,
        conn: &Arc<Connection>,
        scope: &SidebarScope,
        limit: usize,
        before: Option<&SidebarCursor>,
        reuse: Option<&PageReuse<'_>>,
        committed: bool,
    ) -> Result<SidebarPageResult, SidebarError> {
        if let Some(reuse) = reuse
            && before.is_none()
            && committed
        {
            match self.live_window(conn, scope, limit, reuse) {
                Ok(page) => return Ok(page),
                Err(err) => {
                    self.live.reset();
                    return Err(err);
                }
            }
        }
        sidebar_page_storage(conn, scope, limit, before, reuse)
    }

    fn live_window(
        &mut self,
        conn: &Arc<Connection>,
        scope: &SidebarScope,
        limit: usize,
        reuse: &PageReuse<'_>,
    ) -> Result<SidebarPageResult, SidebarError> {
        self.live.sync(conn)?;
        let ids = self.live.index().window(scope, limit);
        let mut active = Vec::with_capacity(ids.active.len());
        for id in &ids.active {
            active.push(self.resolve_entry(conn, id, reuse)?);
        }
        let mut page = Vec::with_capacity(ids.page.len());
        for id in &ids.page {
            page.push(self.resolve_entry(conn, id, reuse)?);
        }
        let before = if ids.more {
            page.last()
                .and_then(|last| sidebar_cursor(&last.thread, scope.archived))
        } else {
            None
        };
        let mut threads = Vec::with_capacity(active.len() + page.len());
        threads.extend(active);
        threads.extend(page);
        Ok(SidebarPageResult {
            threads,
            window: SidebarWindowMeta {
                before,
                total: ids.total,
                counts: ids.counts,
                revision: self.live.revision(),
            },
        })
    }

    fn resolve_entry(
        &self,
        conn: &Arc<Connection>,
        id: &str,
        reuse: &PageReuse<'_>,
    ) -> Result<SidebarEntry, SidebarError> {
        let rev = self.live.index().revision(id);
        if !reuse.changed.contains(id)
            && let Some(retained) = reuse.entries.get(id)
            && Some(retained.revision) == rev
        {
            return Ok(retained.clone());
        }
        read_full_entry(conn, id)
    }
}
