// SPDX-License-Identifier: Apache-2.0

//! Importing one saved session and its provider subagents (`import-history.ts`) as packets: the
//! thread, each agent, its items and blobs, then a barrier and the exact message count.

mod map;
mod packet;
mod plan;
mod reference;
pub mod source;
mod tools;

use history_wire::ImportInit;
use rusqlite::Connection;
use serde_json::{Value, json};

pub use packet::{Emit, Packet};

use crate::cancel::Cancel;
use crate::catalog::{LedgerWriter, Mark, get};
use crate::error::{Error, Result};
use crate::fsread::RecordKind;
use crate::json::{object, string};
use crate::options::{Home, Options};
use crate::session::{Accuracy, Source};
use crate::snapshot::SnapshotScratch;
use map::{Context, map_history};
use plan::INLINE_RAW_BYTES;
use source::{current_fingerprint, import_records};
use tools::complete;

pub use reference::native_reference;

/// How each member of an import is marked in the crash ledger, and where.
pub struct Marks {
    pub writer: LedgerWriter,
    /// One per member: `Verifying` for a suspect read alone, else `Reading`.
    pub kinds: Vec<Mark>,
}

/// A source in the imported tree, with its agent.
pub struct Member {
    pub source: Source,
    pub agent_id: String,
    pub parent_id: Option<String>,
}

/// Everything checked before the first packet: the tree, its support and its fingerprints.
pub fn plan_tree(
    db: &Connection,
    options: &Options,
    init: &ImportInit,
) -> Result<(Home, Vec<Member>)> {
    let root = get(db, &init.source_id)?.ok_or_else(|| Error::message("Unknown history source"))?;
    let home = options
        .instances
        .iter()
        .find(|h| h.id == root.instance_id)
        .cloned()
        .ok_or_else(|| Error::message("History instance is no longer registered"))?;
    if let crate::session::Support::Unsupported { reason } = &root.summary.support {
        return Err(Error::message(reason.clone()));
    }
    let mut members = Vec::new();
    let mut seen = std::collections::HashSet::new();
    collect(db, &home, init, root, None, 0, &mut members, &mut seen)?;
    for member in &members {
        if let crate::session::Support::Unsupported { reason } = &member.source.summary.support {
            return Err(Error::message(reason.clone()));
        }
        if current_fingerprint(&home, &member.source, &Cancel::new())? != member.source.fingerprint
        {
            return Err(Error::message(
                "History source changed; rescan before importing",
            ));
        }
    }
    Ok((home, members))
}

#[allow(clippy::too_many_arguments)]
fn collect(
    db: &Connection,
    home: &Home,
    init: &ImportInit,
    source: Source,
    parent: Option<String>,
    depth: usize,
    members: &mut Vec<Member>,
    seen: &mut std::collections::HashSet<String>,
) -> Result<()> {
    if depth > 16 || members.len() >= 512 {
        return Err(Error::message("Imported agent tree limit exceeded"));
    }
    if !seen.insert(source.summary.id.clone()) {
        return Err(Error::message("Cyclic history agent tree"));
    }
    let agent_id = match &parent {
        None => init.agent_id.clone(),
        Some(_) => format!("{}:{}", init.agent_id, source.summary.id),
    };
    let native = source.summary.native_id.clone();
    members.push(Member {
        source,
        agent_id: agent_id.clone(),
        parent_id: parent,
    });
    for child in crate::catalog::children(db, &home.id, &native)? {
        collect(
            db,
            home,
            init,
            child,
            Some(agent_id.clone()),
            depth + 1,
            members,
            seen,
        )?;
    }
    Ok(())
}

/// Run the import, sending each packet to `emit`. The root's count is returned for the catalog.
pub fn import_history(
    home: &Home,
    members: &[Member],
    init: &ImportInit,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
    marks: &Marks,
    emit: Emit<'_>,
) -> Result<(i64, Accuracy)> {
    let root = &members[0].source;
    emit(Packet::Thread(json!({
        "id": init.thread_id,
        "workspaceId": init.workspace_id,
        "title": root.summary.title,
        "provider": root.summary.provider,
        "rootAgentId": init.agent_id,
        "status": { "state": "done" },
        "settledAt": init.at,
        "settledReason": "manual",
        "unread": false,
        "readAt": init.at,
        "createdAt": init.at,
        "updatedAt": init.at,
        "imported": { "sourceId": init.source_id, "instanceId": home.id, "native": native_reference(root)?, "importedAt": init.at },
    })))?;
    let mut root_count = 0;
    let mut accuracy = Accuracy::Exact;
    for (index, member) in members.iter().enumerate() {
        let s = &member.source.summary;
        let mut agent = json!({
            "id": member.agent_id,
            "threadId": init.thread_id,
            "parentId": member.parent_id,
            "origin": if member.parent_id.is_some() { "provider_subagent" } else { "root" },
            "native": native_reference(&member.source)?,
            "fidelity": "full",
            "cwd": s.cwd,
            "status": { "state": "idle" },
            "createdAt": init.at,
        });
        if let Some(model) = &s.model {
            agent["model"] = json!(model);
        }
        emit(Packet::Agent(agent))?;
        // Marked with its own fingerprint, durably and outside the archive's transaction,
        // before any of it is read; cleared once it is read, whatever the outcome short of
        // killing the reader.
        let (path, fingerprint) = (&member.source.path, &member.source.fingerprint);
        marks
            .writer
            .mark(&home.id, path, marks.kinds[index], fingerprint)?;
        let read = read_member(
            home,
            member,
            init,
            scratch,
            cancel,
            emit,
            &mut root_count,
            &mut accuracy,
        );
        marks.writer.finished(&home.id, path)?;
        read?;
    }
    emit(Packet::Barrier)?;
    for member in members {
        if current_fingerprint(home, &member.source, cancel)? != member.source.fingerprint {
            return Err(Error::message("History source changed during import"));
        }
    }
    Ok((root_count, accuracy))
}

/// Map one member's records into packets.
#[allow(clippy::too_many_arguments)]
fn read_member(
    home: &Home,
    member: &Member,
    init: &ImportInit,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
    emit: Emit<'_>,
    root_count: &mut i64,
    accuracy: &mut Accuracy,
) -> Result<()> {
    let s = &member.source.summary;
    crate::hooks::at_path("import-member", &member.source.path);
    let plan = plan::prepare(home, &member.source, scratch, cancel)?;
    let mut seq = 0;
    let mut ordinal = 0;
    let records = import_records(home, &member.source, scratch, cancel)?;
    crate::hooks::at_path("records-opened", &member.source.path);
    for record in records {
        let record = record?;
        cancel.check()?;
        ordinal += 1;
        if !plan.includes(ordinal)? {
            continue;
        }
        let prefix = format!("{}:{}:{seq}", init.thread_id, s.id);
        seq += 1;
        let value = match &record.kind {
            RecordKind::Value(value) => Some(value),
            _ => None,
        };
        let r = value.map(object);
        let kind = r.and_then(|r| string(r, "type")).unwrap_or("history.raw");
        let kind = history_text::js::prefix(kind, 256).to_owned();
        let raw = if record.bytes > INLINE_RAW_BYTES || value.is_none() {
            let id = format!("{prefix}:raw");
            emit(Packet::BlobStart {
                id: id.clone(),
                bytes: record.bytes,
            })?;
            record.chunks(home, cancel, &mut |chunk| {
                emit(Packet::BlobChunk {
                    id: id.clone(),
                    bytes: chunk.to_vec(),
                })
            })?;
            emit(Packet::BlobEnd { id: id.clone() })?;
            json!({ "type": kind, "blobRef": id, "size": record.bytes, "preview": "" })
        } else {
            json!({ "type": kind, "data": value.cloned().unwrap_or(Value::Null) })
        };
        let Some(value) = value else {
            if member.parent_id.is_none() {
                *accuracy = Accuracy::Sampled;
            }
            emit(Packet::Item(json!({
                "id": prefix, "agentId": member.agent_id, "createdAt": init.at, "complete": true,
                "type": "notice", "level": "info", "code": "history.raw-only", "text": "", "raw": [raw],
            })))?;
            continue;
        };
        let ctx = Context {
            provider: home.provider,
            agent_id: &member.agent_id,
            id_prefix: &prefix,
            at: init.at,
            raw,
            plan: &plan,
        };
        let root = member.parent_id.is_none();
        // Each item leaves as it is made, its call registered before the record's later
        // items are mapped, so a result in the same record finds its call.
        map_history(value, &ctx, &mut |mapped| {
            cancel.check()?;
            let mut item = mapped.item;
            if item["type"] == "tool_call"
                && let Some(native) = &mapped.native
            {
                let id = item["id"].as_str().unwrap_or_default().to_owned();
                plan.record_call(native, &id)?;
                if let Some(completion) = plan.completion(native)? {
                    item = complete(item, &completion, emit)?;
                }
            }
            if root && mapped.message {
                *root_count += 1;
            }
            emit(Packet::Item(item))
        })?;
    }
    Ok(())
}
