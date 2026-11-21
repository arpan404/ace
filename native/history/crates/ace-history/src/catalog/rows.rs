// SPDX-License-Identifier: Apache-2.0

//! Catalog rows: writes during a scan, and the reads lists and imports make.

use history_text::session_title;
use history_wire::ListRequest;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value as Sql};
use serde_json::{Value, json};

use super::Catalog;
use super::display::{blocked_descendant, preferred_duplicate};
use crate::cancel::Cancel;
use crate::error::{Error, Result};
use crate::options::Home;
use crate::paths::{resolve, text};
use crate::session::{Accuracy, Kind, Session, Source, Support};

impl Catalog {
    pub fn remember(
        &self,
        home: &Home,
        path: &str,
        size: u64,
        mtime: f64,
        fingerprint: &str,
        epoch: i64,
    ) -> Result<()> {
        self.db.prepare_cached(
            "INSERT INTO files VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(instance,path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,fingerprint=excluded.fingerprint,home=excluded.home,provider=excluded.provider,epoch=excluded.epoch",
        )?.execute(params![home.id, path, size as i64, mtime, fingerprint, text(&resolve(&home.home_dir)), home.provider.as_str(), epoch])?;
        Ok(())
    }

    /// Begin a scan of one home: its rows not seen again by the end are pruned.
    pub fn start(&self, instance: &str) -> Result<i64> {
        self.db.execute(
            "INSERT INTO scans VALUES (?1,1) ON CONFLICT(instance) DO UPDATE SET epoch = epoch+1",
            [instance],
        )?;
        Ok(self.db.query_row(
            "SELECT epoch FROM scans WHERE instance=?1",
            [instance],
            |row| row.get(0),
        )?)
    }

    pub fn matches(&self, instance: &str, path: &str, fingerprint: &str) -> Result<bool> {
        Ok(self.db.prepare_cached(
            "SELECT 1 FROM files WHERE instance=?1 AND path=?2 AND fingerprint=?3 AND EXISTS (SELECT 1 FROM registered_instances r WHERE r.id=files.instance AND r.home=files.home AND r.provider=files.provider)",
        )?.query_row(params![instance, path, fingerprint], |_| Ok(())).optional()?.is_some())
    }

    pub fn touch(&self, instance: &str, path: &str, fingerprint: &str, epoch: i64) -> Result<bool> {
        let changed = self.db.prepare_cached(
            "UPDATE files SET epoch=?1 WHERE instance=?2 AND path=?3 AND fingerprint=?4 AND EXISTS (SELECT 1 FROM registered_instances r WHERE r.id=files.instance AND r.home=files.home AND r.provider=files.provider)",
        )?.execute(params![epoch, instance, path, fingerprint])?;
        if changed == 0 {
            return Ok(false);
        }
        self.db
            .prepare_cached(
                "UPDATE sources SET epoch=?1 WHERE instance=?2 AND path=?3 AND fingerprint=?4",
            )?
            .execute(params![epoch, instance, path, fingerprint])?;
        Ok(true)
    }

    pub fn put(&self, source: &Source, epoch: i64) -> Result<()> {
        let s = &source.summary;
        let summary = serde_json::to_string(s).map_err(|e| Error::message(e.to_string()))?;
        self.db.prepare_cached(
            "INSERT INTO sources VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,cwd=excluded.cwd,activity=excluded.activity,parent=excluded.parent,summary=excluded.summary,epoch=excluded.epoch,own_activity=excluded.own_activity,hidden=excluded.hidden",
        )?.execute(params![
            s.id, source.instance_id, source.path, source.fingerprint, source.kind.as_str(), s.cwd,
            s.last_activity, s.native_id, s.parent_native_id, summary, epoch, s.last_activity, i64::from(source.hidden)
        ])?;
        Ok(())
    }

    /// Store an import's exact count on the row, through its shown summary as the worker did.
    pub fn update_count(&self, id: &str, count: i64, accuracy: Accuracy) -> Result<()> {
        let Some(mut source) = get(&self.db, id)? else {
            return Ok(());
        };
        source.summary.message_count = count;
        source.summary.count_accuracy = accuracy;
        let summary =
            serde_json::to_string(&source.summary).map_err(|e| Error::message(e.to_string()))?;
        self.db.execute(
            "UPDATE sources SET summary=?1 WHERE id=?2",
            params![summary, id],
        )?;
        Ok(())
    }

    pub fn preserve_path(&self, instance: &str, path: &str, epoch: i64) -> Result<()> {
        self.db
            .prepare_cached("UPDATE files SET epoch=?1 WHERE instance=?2 AND path=?3")?
            .execute(params![epoch, instance, path])?;
        self.db
            .prepare_cached("UPDATE sources SET epoch=?1 WHERE instance=?2 AND path=?3")?
            .execute(params![epoch, instance, path])?;
        Ok(())
    }

    fn pages(
        &self,
        instance: &str,
        cancel: &Cancel,
        progress: &mut dyn FnMut() -> Result<()>,
        update: &dyn Fn(&Connection, &[String]) -> Result<usize>,
    ) -> Result<usize> {
        let mut after = String::new();
        let mut changes = 0;
        loop {
            cancel.check()?;
            let ids: Vec<String> = self
                .db
                .prepare_cached(
                    "SELECT id FROM sources WHERE instance=?1 AND id>?2 ORDER BY id LIMIT 256",
                )?
                .query_map(params![instance, after], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let Some(last) = ids.last() else {
                return Ok(changes);
            };
            after = last.clone();
            changes += update(&self.db, &ids)?;
            progress()?;
        }
    }

    /// A parent is as recent as its most recent descendant.
    pub fn summarize_tree(
        &self,
        instance: &str,
        cancel: &Cancel,
        progress: &mut dyn FnMut() -> Result<()>,
    ) -> Result<()> {
        let list = |ids: &[String]| vec!["?"; ids.len()].join(",");
        self.pages(instance, cancel, progress, &|db, ids| {
            Ok(db.execute(
                &format!("UPDATE sources SET activity=own_activity,summary=json_set(summary,'$.lastActivity',own_activity) WHERE id IN ({})", list(ids)),
                params_from_iter(ids),
            )?)
        })?;
        let recency = "MAX(own_activity,COALESCE((SELECT MAX(child.activity) FROM sources child WHERE child.instance=parent.instance AND child.parent=parent.native),own_activity))";
        for _ in 0..16 {
            let changes = self.pages(instance, cancel, progress, &|db, ids| {
                Ok(db.execute(
                    &format!("UPDATE sources AS parent SET activity={recency},summary=json_set(summary,'$.lastActivity',{recency}) WHERE id IN ({}) AND activity<>{recency}", list(ids)),
                    params_from_iter(ids),
                )?)
            })?;
            if changes == 0 {
                break;
            }
        }
        Ok(())
    }

    /// Remove what this scan did not see again. Returns whether anything went.
    pub fn prune(&self, instance: &str, epoch: i64, cancel: &Cancel) -> Result<bool> {
        let mut changed = false;
        for table in ["sources", "files"] {
            loop {
                cancel.check()?;
                let removed = self.db.execute(
                    &format!("DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE instance=?1 AND epoch<>?2 LIMIT 256)"),
                    params![instance, epoch],
                )?;
                if removed == 0 {
                    break;
                }
                changed = true;
            }
        }
        loop {
            cancel.check()?;
            let removed = self.db.execute(
                "DELETE FROM native_titles WHERE rowid IN (SELECT t.rowid FROM native_titles t WHERE t.instance=?1 AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.instance=t.instance AND s.native=t.native) LIMIT 256)",
                [instance],
            )?;
            if removed == 0 {
                break;
            }
        }
        Ok(changed)
    }

    pub fn set_native_title(
        &self,
        instance: &str,
        native: &str,
        title: &str,
        origin: &str,
    ) -> Result<()> {
        self.db.prepare_cached(
            "INSERT INTO native_titles SELECT ?1,?2,?3,?4 WHERE EXISTS (SELECT 1 FROM sources WHERE instance=?1 AND native=?2) ON CONFLICT(instance,native) DO UPDATE SET title=excluded.title,origin=excluded.origin WHERE excluded.origin='index' OR native_titles.origin<>'index'",
        )?.execute(params![instance, native, title, origin])?;
        Ok(())
    }
}

/// The visible child sessions of a native session, one per native id.
pub fn children(db: &Connection, instance: &str, native: &str) -> Result<Vec<Source>> {
    let ids: Vec<String> = db
        .prepare_cached(&format!(
            "SELECT id FROM visible_sources sources WHERE instance=?1 AND parent=?2 AND NOT EXISTS ({}) LIMIT 513",
            preferred_duplicate("sources")
        ))?
        .query_map(params![instance, native], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        if let Some(source) = get(db, &id)? {
            out.push(source);
        }
    }
    Ok(out)
}

/// A stored summary as shown: the native title when known, and an unreadable descendant.
pub fn display(db: &Connection, json: &str) -> Result<Session> {
    let mut summary: Session =
        serde_json::from_str(json).map_err(|e| Error::message(e.to_string()))?;
    let title: Option<Option<String>> = db
        .prepare_cached("SELECT title FROM native_titles WHERE instance=?1 AND native=?2")?
        .query_row(params![summary.instance_id, summary.native_id], |row| {
            row.get(0)
        })
        .optional()?;
    let reason: Option<Option<String>> = db
        .prepare_cached(&format!(
            "SELECT ({}) AS reason FROM visible_sources sources WHERE id=?1",
            blocked_descendant()
        ))?
        .query_row([&summary.id], |row| row.get(0))
        .optional()?;
    let native = title
        .flatten()
        .filter(|t| *t != summary.native_id)
        .unwrap_or_default();
    // The scanner already distinguished provider labels from the person's real prompt.
    summary.title = session_title(&native, &summary.title, summary.last_activity);
    if let Some(reason) = reason.flatten() {
        summary.support = Support::unsupported(format!(
            "Part of this session's history can't be opened. {reason}"
        ));
    }
    Ok(summary)
}

/// One visible row, by id.
pub fn get(db: &Connection, id: &str) -> Result<Option<Source>> {
    let row: Option<(String, String, String, String, String, i64)> = db
        .prepare_cached(
            "SELECT summary,path,fingerprint,kind,instance,hidden FROM visible_sources WHERE id=?1",
        )?
        .query_row([id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .optional()?;
    let Some((summary, path, fingerprint, kind, instance_id, hidden)) = row else {
        return Ok(None);
    };
    Ok(Some(Source {
        summary: display(db, &summary)?,
        path,
        fingerprint,
        kind: Kind::parse(&kind).ok_or_else(|| Error::message("Unknown catalog source kind"))?,
        instance_id,
        hidden: hidden == 1,
    }))
}

/// One page of a workspace's sessions. `exclude` holds `provider:nativeId` keys ace owns.
pub fn list(db: &Connection, request: &ListRequest, exclude: &[String]) -> Result<Value> {
    let limit = request.limit.clamp(1, 200);
    let cursor = if request.before.is_some() {
        " AND (activity<? OR (activity=? AND id<?))"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id,activity,summary FROM visible_sources sources WHERE cwd=? AND parent IS NULL AND hidden=0 AND (?=0 OR (json_extract(summary,'$.support.status')='supported' AND NOT EXISTS ({}))) AND (?='' OR instr(lower(COALESCE((SELECT title FROM native_titles t WHERE t.instance=sources.instance AND t.native=sources.native),json_extract(summary,'$.title'))),lower(?))>0) AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value=json_extract(summary,'$.provider')||':'||sources.native) AND NOT EXISTS ({}){cursor} ORDER BY activity DESC,id DESC LIMIT ?",
        blocked_descendant(),
        preferred_duplicate("sources")
    );
    let search = request.search.clone().unwrap_or_default();
    let mut values: Vec<Sql> = vec![
        Sql::Text(request.cwd.clone()),
        Sql::Integer(i64::from(request.openable_only == Some(true))),
        Sql::Text(search.clone()),
        Sql::Text(search),
        Sql::Text(serde_json::to_string(exclude).unwrap_or_else(|_| "[]".to_owned())),
    ];
    if let Some(before) = &request.before {
        values.extend([
            Sql::Integer(before.last_activity),
            Sql::Integer(before.last_activity),
            Sql::Text(before.id.clone()),
        ]);
    }
    values.push(Sql::Integer(limit + 1));
    let rows: Vec<(String, i64, String)> = db
        .prepare_cached(&sql)?
        .query_map(params_from_iter(values), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let shown = &rows[..rows.len().min(limit as usize)];
    let mut sessions = Vec::with_capacity(shown.len());
    for (_, activity, summary) in shown {
        let mut session = display(db, summary)?;
        session.last_activity = *activity;
        sessions.push(serde_json::to_value(session).map_err(|e| Error::message(e.to_string()))?);
    }
    let next = match shown.last() {
        Some((id, activity, _)) if rows.len() > limit as usize => {
            json!({ "lastActivity": activity, "id": id })
        }
        _ => Value::Null,
    };
    Ok(json!({ "type": "history.list", "sessions": sessions, "next": next }))
}
