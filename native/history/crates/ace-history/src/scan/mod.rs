// SPDX-License-Identifier: Apache-2.0

//! The inventory scan (`scan.ts`): walk each home, skip what is unchanged, sample the rest eight
//! at a time, and write each batch of 64 in one transaction.

mod codex;
mod database;
mod sample;
mod storage;
mod summary;
mod tally;
pub mod user;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

pub use tally::Tally;

use crate::cancel::Cancel;
use crate::catalog::{Catalog, Mark, Verdict};
use crate::error::{Error, Result, io_at};
use crate::fsread::stat::{fingerprint_at, mtime_ms};
use crate::fsread::{Budget, walk_files};
use crate::options::{Home, Options, Provider};
use crate::paths::text;
use crate::session::{Kind, Source};
use crate::snapshot::SnapshotScratch;
use sample::{Read, read_content};

const BATCH: usize = 64;

/// One read's counts and outcome.
type Outcome = (Read, Result<sample::Found>);
const READERS: usize = 8;

/// Everything a scan uses.
pub struct Scan<'a> {
    pub catalog: &'a mut Catalog,
    pub scratch: &'a SnapshotScratch,
    pub options: &'a Options,
    pub cancel: &'a Cancel,
    pub now: &'a dyn Fn() -> f64,
    pub progress: &'a mut dyn FnMut(&Tally),
    pub tally: Tally,
}

/// A catalog write, applied inside the batch's transaction.
enum Write {
    Touch {
        path: String,
        fingerprint: String,
    },
    Preserve {
        path: String,
    },
    Put {
        source: Box<Source>,
        size: u64,
        mtime: f64,
    },
}

struct Job {
    path: PathBuf,
    size: u64,
    mtime: f64,
    fingerprint: String,
}

enum Pre {
    Done(Option<Write>),
    Read(Job),
}

/// Where each provider keeps its transcripts.
pub fn inventory_roots(home: &Home) -> Vec<PathBuf> {
    match home.provider {
        Provider::Claude => vec![home.home_dir.join("projects")],
        Provider::Pi => vec![home.home_dir.join("sessions")],
        Provider::Codex => vec![
            home.home_dir.join("sessions"),
            home.home_dir.join("archived_sessions"),
        ],
        _ => vec![home.home_dir.join("storage/session")],
    }
}

impl Scan<'_> {
    fn report(&mut self) -> Result<()> {
        (self.progress)(&self.tally);
        self.cancel.check()
    }

    /// Scan every home this reader owns. Returns the tally.
    pub fn run(mut self) -> Result<Tally> {
        self.catalog.cleanup(self.cancel)?;
        let homes: Vec<Home> = self.options.instances.to_vec();
        for home in &homes {
            self.cancel.check()?;
            if home.provider == Provider::Cursor {
                self.tally.unsupported(
                    &home.id,
                    "Cursor transcripts omit tool outputs; TUI chats cannot be loaded through ACP",
                );
                continue;
            }
            self.home(home)?;
        }
        (self.progress)(&self.tally);
        Ok(self.tally)
    }

    fn home(&mut self, home: &Home) -> Result<()> {
        let epoch = self.catalog.start(&home.id)?;
        let reads_before = self.tally.reads;
        let mut budget = Budget::default();
        let mut batch: Vec<PathBuf> = Vec::new();
        for root in inventory_roots(home) {
            let cancel = self.cancel.clone();
            walk_files(&root, &cancel, &mut budget, &mut |path: &Path| {
                batch.push(path.to_owned());
                if batch.len() == BATCH {
                    let paths = std::mem::take(&mut batch);
                    self.flush(home, epoch, paths)?;
                }
                Ok(())
            })?;
        }
        if !batch.is_empty() {
            self.flush(home, epoch, batch)?;
        }
        // Only recognized database names in the home root are opened, never auth or config.
        database::databases(self, home, epoch)?;
        if home.provider == Provider::Codex {
            codex::titles(self, home, epoch)?;
        }
        self.cancel.check()?;
        let removed = self.catalog.prune(&home.id, epoch, self.cancel)?;
        // A repeated scan in the same session already has recency for unchanged sources.
        if removed || self.tally.reads != reads_before {
            let tally = self.tally.clone();
            let progress = &mut *self.progress;
            self.catalog
                .summarize_tree(&home.id, self.cancel, &mut || {
                    progress(&tally);
                    Ok(())
                })?;
        }
        Ok(())
    }

    /// The outcome of a failed sample: counted, never thrown, except cancellation.
    fn failed(&mut self, home: &Home, path: &Path, error: Error) -> Result<Option<Write>> {
        if matches!(error, Error::Aborted) {
            return Err(error);
        }
        let missing = matches!(error, Error::Missing(_));
        // A source that changed while sampled is read by the next scan the person asks for.
        if !error.is_change() && !missing {
            self.tally.unsupported(&home.id, &error.to_string());
        }
        self.tally.skipped += 1;
        // A sampling race never changes or prunes the last successfully indexed row.
        Ok((!missing).then(|| Write::Preserve { path: text(path) }))
    }

    fn precheck(&mut self, home: &Home, path: &Path) -> Result<Pre> {
        let name = text(path);
        let stored = home.provider == Provider::Opencode;
        if !name.ends_with(if stored { ".json" } else { ".jsonl" }) {
            if name.ends_with(".zst") && !self.tally.unsupported.iter().any(|(i, _)| *i == home.id)
            {
                self.tally.unsupported(
                    &home.id,
                    "Compressed Codex rollouts require provider-owned materialization",
                );
            }
            return Ok(Pre::Done(None));
        }
        self.tally.files += 1;
        if self.tally.files.is_multiple_of(64) {
            self.report()?;
        }
        let info = std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?;
        crate::hooks::at_path("scan-stat", &name);
        let fp = if stored {
            crate::opencode::storage::fingerprint(home, path, self.cancel)?
        } else {
            fingerprint_at(path)?
        };
        if self.catalog.matches(&home.id, &name, &fp)? {
            self.tally.skipped += 1;
            return Ok(Pre::Done(Some(Write::Touch {
                path: name,
                fingerprint: fp,
            })));
        }
        if let Verdict::Blocked(reason) =
            self.catalog
                .crashes
                .verdict(&home.id, &name, Some(&fp), (self.now)())
        {
            self.tally.unsupported(&home.id, &reason);
            self.tally.skipped += 1;
            return Ok(Pre::Done(Some(Write::Preserve { path: name })));
        }
        Ok(Pre::Read(Job {
            path: path.to_owned(),
            size: info.len(),
            mtime: mtime_ms(&info),
            fingerprint: fp,
        }))
    }

    fn flush(&mut self, home: &Home, epoch: i64, paths: Vec<PathBuf>) -> Result<()> {
        let mut writes = Vec::new();
        let now = (self.now)();
        // Suspects from a crashed scan are read on their own, so another crash names its cause.
        let (alone, together): (Vec<PathBuf>, Vec<PathBuf>) = paths.into_iter().partition(|p| {
            self.catalog.crashes.verdict(&home.id, &text(p), None, now) == Verdict::Isolate
        });
        for path in alone {
            let write = match self.precheck(home, &path) {
                Ok(Pre::Done(write)) => write,
                Ok(Pre::Read(job)) => {
                    let name = text(&job.path);
                    self.catalog.crashes.mark(
                        &home.id,
                        &name,
                        Mark::Verifying,
                        &job.fingerprint,
                    )?;
                    let outcome = self.read_jobs(home, std::slice::from_ref(&job));
                    self.catalog.crashes.finished(&home.id, &name)?;
                    self.settle(home, job, outcome.into_iter().next())?
                }
                Err(error) => self.failed(home, &path, error)?,
            };
            writes.extend(write);
        }
        let mut jobs = Vec::new();
        for path in together {
            match self.precheck(home, &path) {
                Ok(Pre::Done(write)) => writes.extend(write),
                Ok(Pre::Read(job)) => jobs.push(job),
                Err(error) => writes.extend(self.failed(home, &path, error)?),
            }
        }
        // Sixteen in flight at most, as before: a crash leaves at most that many suspects.
        let mut jobs = jobs.into_iter().peekable();
        while jobs.peek().is_some() {
            let group: Vec<Job> = jobs.by_ref().take(16).collect();
            let names: Vec<String> = group.iter().map(|job| text(&job.path)).collect();
            let marks: Vec<(&str, &str, Mark, &str)> = group
                .iter()
                .zip(&names)
                .map(|(job, name)| {
                    (
                        home.id.as_str(),
                        name.as_str(),
                        Mark::Reading,
                        job.fingerprint.as_str(),
                    )
                })
                .collect();
            self.catalog.crashes.mark_all(&marks)?;
            let outcomes = self.read_jobs(home, &group);
            for job in &group {
                self.catalog.crashes.finished(&home.id, &text(&job.path))?;
            }
            for (job, outcome) in group.into_iter().zip(outcomes) {
                writes.extend(self.settle(home, job, Some(outcome))?);
            }
        }
        self.cancel.check()?;
        self.catalog.transaction(|catalog| {
            for write in &writes {
                match write {
                    Write::Touch { path, fingerprint } => {
                        catalog.touch(&home.id, path, fingerprint, epoch)?;
                    }
                    Write::Preserve { path } => catalog.preserve_path(&home.id, path, epoch)?,
                    Write::Put {
                        source,
                        size,
                        mtime,
                    } => {
                        catalog.put(source, epoch)?;
                        catalog.remember(
                            home,
                            &source.path,
                            *size,
                            *mtime,
                            &source.fingerprint,
                            epoch,
                        )?;
                    }
                }
            }
            Ok(())
        })?;
        self.cancel.check()
    }

    /// Read jobs on up to eight threads; outcomes come back in job order.
    fn read_jobs(&self, home: &Home, jobs: &[Job]) -> Vec<Outcome> {
        let large = Mutex::new(());
        let next = AtomicUsize::new(0);
        let results: Mutex<Vec<Option<Outcome>>> =
            Mutex::new((0..jobs.len()).map(|_| None).collect());
        std::thread::scope(|scope| {
            for _ in 0..READERS.min(jobs.len()) {
                scope.spawn(|| {
                    loop {
                        let index = next.fetch_add(1, Ordering::SeqCst);
                        let Some(job) = jobs.get(index) else { break };
                        let mut read = Read::default();
                        let found = if home.provider == Provider::Opencode {
                            storage::read_storage(
                                home,
                                &job.path,
                                self.scratch,
                                self.cancel,
                                &large,
                                &mut read,
                            )
                        } else {
                            read_content(
                                home,
                                &job.path,
                                &job.fingerprint,
                                self.cancel,
                                &large,
                                &mut read,
                            )
                        };
                        if let Ok(mut slots) = results.lock() {
                            slots[index] = Some((read, found));
                        }
                    }
                });
            }
        });
        results
            .into_inner()
            .unwrap_or_default()
            .into_iter()
            .map(|slot| {
                slot.unwrap_or_else(|| {
                    (
                        Read::default(),
                        Err(Error::message("Saved conversation read was lost")),
                    )
                })
            })
            .collect()
    }

    fn settle(&mut self, home: &Home, job: Job, outcome: Option<Outcome>) -> Result<Option<Write>> {
        let Some((read, found)) = outcome else {
            return Ok(None);
        };
        self.tally.reads += read.reads;
        self.tally.bytes += read.bytes;
        for notice in &read.notices {
            self.tally.unsupported(&home.id, notice);
        }
        match found {
            Ok(found) => Ok(Some(Write::Put {
                source: Box::new(Source {
                    summary: found.summary,
                    hidden: found.hidden,
                    path: text(&job.path),
                    fingerprint: job.fingerprint,
                    kind: if home.provider == Provider::Opencode {
                        Kind::Storage
                    } else {
                        Kind::Jsonl
                    },
                    instance_id: home.id.clone(),
                }),
                size: job.size,
                mtime: job.mtime,
            })),
            Err(error) => self.failed(home, &job.path, error),
        }
    }
}
