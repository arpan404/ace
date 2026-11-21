// SPDX-License-Identifier: Apache-2.0

//! The main thread: start the index, then run each operation the daemon sends, one at a time.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Instant;

use history_wire::{ArchiveCommand, ImportInit, Request, take_body_index};
use rusqlite::Connection;
use serde_json::{Value, json};

use crate::archive::{self, Archive, Command};
use crate::cancel::Cancel;
use crate::catalog::{Catalog, get, list, open_reader};
use crate::error::{Error, Result};
use crate::import::{self, Member, Packet};
use crate::options::{Home, Options};
use crate::scan::{Scan, Tally};
use crate::session::Accuracy;
use crate::setup::{now, prepare_index, validate_index_path};
use crate::snapshot::{Policy, SnapshotScratch};
use crate::transport::Out;
use crate::{Op, ToMain};

/// An import being pulled packet by packet (`import`, then `next` until done).
struct Pull {
    packets: mpsc::Receiver<Produced>,
    /// How many packets the producer may make: exactly what the daemon pulled, as the worker's
    /// generator ran, so nothing is read ahead of the sink and the final checks run only after
    /// everything before the barrier was taken.
    credits: mpsc::SyncSender<usize>,
    root: String,
}

enum Produced {
    Packet(Packet),
    Done(Result<(i64, Accuracy)>),
}

struct Server {
    options: Options,
    catalog: Catalog,
    archive: Archive,
    scratch: SnapshotScratch,
    cancel: Cancel,
    out: Out,
    pull: Option<Pull>,
}

pub fn serve(
    out: &Out,
    cancel: &Cancel,
    busy: &AtomicBool,
    inbox: &mpsc::Receiver<ToMain>,
    reads: mpsc::Receiver<Op>,
) -> i32 {
    let options = loop {
        match inbox.recv() {
            Ok(ToMain::Init(value)) => break value,
            Ok(ToMain::Op(op)) => {
                out.error(op.id, "The history reader has not started");
                busy.store(false, Ordering::SeqCst);
            }
            Err(_) => return 0,
        }
    };
    let mut server = match start(options, cancel, out) {
        Ok(Some(server)) => server,
        // Refused: wait for the daemon to stop this reader.
        Ok(None) => loop {
            if inbox.recv().is_err() {
                return 0;
            }
        },
        Err(error) => {
            out.send(
                &json!({ "fault": { "message": error.to_string() } }),
                &[],
                0,
            );
            return 1;
        }
    };
    match open_reader(&server.options.index_path, &server.options.instances) {
        Ok(reader) => {
            let out = out.clone();
            std::thread::spawn(move || serve_reads(&reader, &reads, &out));
        }
        Err(error) => {
            out.send(
                &json!({ "fault": { "message": error.to_string() } }),
                &[],
                0,
            );
            return 1;
        }
    }
    out.reply(0, json!("ready"));
    // After `close` the reader waits to be stopped, or for stdin to close: exiting by itself
    // would race the daemon's own stop and read as a crash.
    while let Ok(message) = inbox.recv() {
        let ToMain::Op(op) = message else { continue };
        let (id, reply) = server.handle(op);
        // Idle before the reply is out: the daemon's next request, sent the moment it reads the
        // reply, must never find this one still in progress.
        busy.store(false, Ordering::SeqCst);
        server.publish(id, reply);
    }
    0
}

fn start(value: Value, cancel: &Cancel, out: &Out) -> Result<Option<Server>> {
    let options: Options = serde_json::from_value(value)
        .map_err(|e| Error::message(format!("Invalid history options: {e}")))?;
    validate_index_path(&options.index_path, &options.instances)?;
    prepare_index(&options.index_path)?;
    let own = options.own_instances();
    let mut catalog = match Catalog::open(&options.index_path, now(), options.last_exit, &own)? {
        Ok(catalog) => catalog,
        Err(refused) => {
            out.send(&json!({ "refused": { "code": "incompatible-data", "path": refused.path, "message": refused.message } }), &[], 0);
            return Ok(None);
        }
    };
    let root = options
        .index_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default();
    let scratch = SnapshotScratch::new(root, Policy::from_limits(options.snapshot.as_ref()));
    // Nothing can own a snapshot before this reader starts: remove crash and restart leftovers.
    scratch.sweep()?;
    catalog.reconcile(&options.instances)?;
    let archive = Archive::open(&catalog.db)?;
    Ok(Some(Server {
        options,
        catalog,
        archive,
        scratch,
        cancel: cancel.clone(),
        out: out.clone(),
        pull: None,
    }))
}

fn serve_reads(reader: &Connection, reads: &mpsc::Receiver<Op>, out: &Out) {
    while let Ok(op) = reads.recv() {
        let value = match &op.request {
            Ok(Request::List { request, exclude }) => list(reader, request, exclude),
            Ok(Request::Get { id }) => get(reader, id).and_then(|s| match s {
                Some(source) => {
                    serde_json::to_value(source.summary).map_err(|e| Error::message(e.to_string()))
                }
                None => Ok(Value::Null),
            }),
            _ => Err(Error::message("History read failed")),
        };
        match value {
            Ok(value) => out.reply(op.id, value),
            Err(error) => out.error(op.id, &error.to_string()),
        }
    }
}

/// What an operation answers.
enum Reply {
    Value(Value),
    Bodies(Value, Vec<Vec<u8>>),
    /// The source is another reader's: the daemon routes the request there.
    Elsewhere,
}

fn summary_value(source: Option<crate::session::Source>) -> Result<Value> {
    source.map_or(Ok(Value::Null), |s| {
        serde_json::to_value(s.summary).map_err(|e| Error::message(e.to_string()))
    })
}

impl Server {
    /// Run one operation to its end, its state settled, and return what it answers.
    fn handle(&mut self, op: Op) -> (i64, Result<Reply>) {
        let reply = match op.request {
            Ok(request) => self.run(request, &op.bodies),
            Err(name) => Err(Error::message(format!("Unhandled history request: {name}"))),
        };
        if reply.is_err() {
            // A failed import step ends the import, closing its files and plan.
            self.pull = None;
        }
        (op.id, reply)
    }

    fn publish(&self, id: i64, reply: Result<Reply>) {
        self.send_reply(id, reply);
        crate::hooks::at("reply-sent");
    }

    fn send_reply(&self, id: i64, reply: Result<Reply>) {
        match reply {
            Ok(Reply::Value(value)) => self.out.reply(id, value),
            Ok(Reply::Bodies(value, bodies)) => self.out.reply_bodies(id, value, &bodies),
            Ok(Reply::Elsewhere) => self.out.send(
                &json!({ "id": id, "error": "This saved conversation is read by another reader", "elsewhere": true }),
                &[],
                id,
            ),
            Err(error) => self.out.error(id, &error.to_string()),
        }
    }

    fn run(&mut self, request: Request, bodies: &[Vec<u8>]) -> Result<Reply> {
        let value = match request {
            Request::Close => {
                self.cancel.cancel();
                self.pull = None;
                self.archive.write(&self.catalog.db, Command::Rollback)?;
                Value::Null
            }
            Request::ArchiveWrite { command } => {
                self.archive_write(command, bodies)?;
                Value::Null
            }
            Request::ArchiveDelete { id } => {
                self.archive.delete(&self.catalog.db, &id)?;
                Value::Null
            }
            Request::ArchiveSource { id } => archive::find(&self.catalog.db, &id)?,
            Request::ArchiveThread { id } => archive::get(&self.catalog.db, &id)?,
            Request::ArchiveAgents { id } => archive::agents(&self.catalog.db, &id)?,
            Request::ArchivePage { request } => archive::page(
                &self.catalog.db,
                &request.thread_id,
                request.after,
                request.limit,
            )?,
            Request::ArchiveBlob { request } => {
                let (bytes, size) = archive::read_blob(
                    &self.catalog.db,
                    &request.id,
                    request.offset,
                    request.limit,
                )?;
                return Ok(Reply::Bodies(
                    json!({ "bytes": history_wire::body_ref(0), "size": size }),
                    vec![bytes],
                ));
            }
            Request::Scan => self.scan()?,
            Request::List { request, exclude } => list(self.catalog.reader(), &request, &exclude)?,
            Request::Get { id } => summary_value(get(self.catalog.reader(), &id)?)?,
            Request::Reference { id } => {
                if !self.owns(&id)? {
                    return Ok(Reply::Elsewhere);
                }
                get(self.catalog.reader(), &id)?.map_or(Value::Null, |s| json!(s.summary.native_id))
            }
            Request::ImportPersist { init } => {
                if !self.owns(&init.source_id)? {
                    return Ok(Reply::Elsewhere);
                }
                self.persist(&init)?
            }
            Request::Import { init } => {
                if !self.owns(&init.source_id)? {
                    return Ok(Reply::Elsewhere);
                }
                if self.pull.is_some() {
                    return Err(Error::message("Import already in progress"));
                }
                self.begin_pull(&init)?;
                return self.pull_packets(1);
            }
            Request::Next => {
                if self.pull.is_none() {
                    return Err(Error::message("No import in progress"));
                }
                self.cancel.check()?;
                return self.pull_packets(16);
            }
            Request::Return => {
                self.pull = None;
                Value::Null
            }
        };
        Ok(Reply::Value(value))
    }

    /// Whether this reader imports the source; an unknown one is this reader's to refuse.
    fn owns(&self, id: &str) -> Result<bool> {
        Ok(import::owner(self.catalog.reader(), &self.options, id)?.unwrap_or(true))
    }

    fn archive_write(&mut self, command: ArchiveCommand, bodies: &[Vec<u8>]) -> Result<()> {
        let db = &self.catalog.db;
        let command = match &command {
            ArchiveCommand::Begin { thread } => Command::Begin(thread),
            ArchiveCommand::Agent { agent } => Command::Agent(agent),
            ArchiveCommand::Item { item } => Command::Item(item),
            ArchiveCommand::BlobStart { id, bytes } => Command::BlobStart { id, bytes: *bytes },
            ArchiveCommand::BlobChunk { id, bytes } => {
                let body = take_body_index(bytes)
                    .and_then(|i| bodies.get(i))
                    .ok_or_else(|| Error::message("Invalid blob chunk"))?;
                Command::BlobChunk { id, bytes: body }
            }
            ArchiveCommand::BlobEnd { id } => Command::BlobEnd { id },
            ArchiveCommand::Commit => Command::Commit,
            ArchiveCommand::Rollback => Command::Rollback,
        };
        self.archive.write(db, command)
    }

    fn scan(&mut self) -> Result<Value> {
        let out = self.out.clone();
        let mut last: Option<Instant> = None;
        // Intermediate inventories are bounded to one every 250 ms; the final one always goes.
        let mut progress = |tally: &Tally| {
            if last.is_some_and(|at| at.elapsed().as_millis() < 250) {
                return;
            }
            last = Some(Instant::now());
            out.send(
                &json!({ "progress": tally.files, "result": tally.to_json() }),
                &[],
                0,
            );
        };
        let scan = Scan {
            catalog: &mut self.catalog,
            scratch: &mut self.scratch,
            options: &self.options,
            cancel: &self.cancel,
            now: &now,
            progress: &mut progress,
            tally: Tally::default(),
        };
        let tally = scan.run()?;
        self.out.send(
            &json!({ "progress": tally.files, "result": tally.to_json() }),
            &[],
            0,
        );
        Ok(tally.to_json())
    }

    fn persist(&mut self, init: &ImportInit) -> Result<Value> {
        let (home, members) = import::plan_tree(self.catalog.reader(), &self.options, init)?;
        // A staged import is one long transaction: a 16 MiB page cache, for its length only,
        // keeps SQLite from spilling the same pages to the WAL again and again.
        self.catalog.db.execute_batch("PRAGMA cache_size=-16384")?;
        let outcome = self.persist_tree(&home, &members, init);
        self.catalog.db.execute_batch("PRAGMA cache_size=-1024")?;
        outcome
    }

    fn persist_tree(
        &mut self,
        home: &Home,
        members: &[Member],
        init: &ImportInit,
    ) -> Result<Value> {
        let db = &self.catalog.db;
        let archive = &mut self.archive;
        let mut began = false;
        let mut packets = 0u64;
        let cancel = self.cancel.clone();
        let outcome = import::import_history(
            home,
            members,
            init,
            &self.scratch,
            &self.cancel,
            &mut |packet| {
                packets += 1;
                cancel.check()?;
                match &packet {
                    Packet::Thread(thread) => {
                        archive.write(db, Command::Begin(thread))?;
                        began = true;
                    }
                    Packet::Agent(agent) => archive.write(db, Command::Agent(agent))?,
                    Packet::Item(item) => archive.write(db, Command::Item(item))?,
                    Packet::BlobStart { id, bytes } => archive.write(
                        db,
                        Command::BlobStart {
                            id,
                            bytes: *bytes as i64,
                        },
                    )?,
                    Packet::BlobChunk { id, bytes } => {
                        archive.write(db, Command::BlobChunk { id, bytes })?
                    }
                    Packet::BlobEnd { id } => archive.write(db, Command::BlobEnd { id })?,
                    Packet::Barrier | Packet::End { .. } => {}
                }
                Ok(())
            },
        )
        .and_then(|(count, accuracy)| {
            self.cancel.check()?;
            self.catalog
                .update_count(&init.source_id, count, accuracy)?;
            self.archive.write(&self.catalog.db, Command::Commit)?;
            Ok(json!({ "messageCount": count, "countAccuracy": accuracy_text(accuracy) }))
        });
        if outcome.is_err() && (began || self.archive.active()) {
            let _ = self.archive.write(&self.catalog.db, Command::Rollback);
        }
        outcome
    }

    fn begin_pull(&mut self, init: &ImportInit) -> Result<()> {
        let (home, members) = import::plan_tree(self.catalog.reader(), &self.options, init)?;
        // The producer makes only what each pull grants, so at most sixteen packets wait.
        let (send, packets) = mpsc::sync_channel::<Produced>(16);
        let (credits, granted) = mpsc::sync_channel::<usize>(1);
        let scratch = SnapshotScratch::new(
            self.scratch.root.clone(),
            Policy::from_limits(self.options.snapshot.as_ref()),
        );
        let cancel = self.cancel.clone();
        let root = init.source_id.clone();
        let init = init.clone();
        std::thread::spawn(move || {
            produce(&home, &members, &init, &scratch, &cancel, &send, &granted)
        });
        self.pull = Some(Pull {
            packets,
            credits,
            root,
        });
        Ok(())
    }

    /// Up to `limit` packets, stopping after a barrier, as the worker's `pullPackets`.
    fn pull_packets(&mut self, limit: usize) -> Result<Reply> {
        let mut values = Vec::new();
        let mut bodies = Vec::new();
        if let Some(pull) = &self.pull {
            let _ = pull.credits.send(limit);
        }
        while values.len() < limit {
            let Some(pull) = &self.pull else { break };
            self.cancel.check()?;
            match pull.packets.recv() {
                Ok(Produced::Packet(packet)) => {
                    let barrier = packet == Packet::Barrier;
                    values.push(packet.to_json(&mut bodies));
                    if barrier {
                        break;
                    }
                }
                Ok(Produced::Done(Ok((count, accuracy)))) => {
                    let root = pull.root.clone();
                    self.pull = None;
                    self.catalog.update_count(&root, count, accuracy)?;
                    values.push(Packet::End { count, accuracy }.to_json(&mut bodies));
                    return Ok(Reply::Bodies(
                        json!({ "done": true, "values": values }),
                        bodies,
                    ));
                }
                Ok(Produced::Done(Err(error))) => {
                    self.pull = None;
                    return Err(error);
                }
                Err(_) => {
                    self.pull = None;
                    return Err(Error::message("Incomplete history import"));
                }
            }
        }
        Ok(Reply::Bodies(
            json!({ "done": self.pull.is_none(), "values": values }),
            bodies,
        ))
    }
}

fn accuracy_text(accuracy: Accuracy) -> &'static str {
    match accuracy {
        Accuracy::Exact => "exact",
        Accuracy::Sampled => "sampled",
    }
}

fn produce(
    home: &Home,
    members: &[Member],
    init: &ImportInit,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
    send: &mpsc::SyncSender<Produced>,
    granted: &mpsc::Receiver<usize>,
) {
    let mut credit = 0usize;
    let outcome = import::import_history(home, members, init, scratch, cancel, &mut |packet| {
        while credit == 0 {
            credit = granted.recv().map_err(|_| Error::Aborted)?;
        }
        let barrier = packet == Packet::Barrier;
        send.send(Produced::Packet(packet))
            .map_err(|_| Error::Aborted)?;
        credit -= 1;
        if barrier {
            // A pull ends at a barrier: what it left unused is not the producer's to spend, and
            // the checks after the barrier wait for the daemon's next pull.
            credit = granted.recv().map_err(|_| Error::Aborted)?;
        }
        Ok(())
    });
    let _ = send.send(Produced::Done(outcome));
}
