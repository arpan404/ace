// SPDX-License-Identifier: Apache-2.0

//! Provider databases in a home's root (the database half of `scan.ts`): each read one at a time
//! from a pinned file or a private snapshot, inside a savepoint, with backoff after a failure and
//! a crash mark while it is read.

use super::{Scan, codex};
use crate::catalog::{Mark, Verdict};
use crate::error::{Error, Result, io_at};
use crate::fsread::stat::mtime_ms;
use crate::options::{Home, Provider};
use crate::paths::text;
use crate::session::{Kind, Session, Source};
use crate::snapshot::{BUSY, CHANGED, database_fingerprint, open_provider_db};

/// The database names a provider keeps in its home root: Codex's `state_<n>.sqlite`, OpenCode's
/// `opencode.db` and `opencode-<channel>.db`. Nothing else in the root is opened.
fn is_database(provider: Provider, name: &str) -> bool {
    match provider {
        Provider::Codex => codex::is_state_db(name),
        Provider::Opencode => name
            .strip_prefix("opencode")
            .and_then(|rest| rest.strip_suffix(".db"))
            .is_some_and(|rest| {
                rest.is_empty()
                    || rest.strip_prefix('-').is_some_and(|channel| {
                        !channel.is_empty()
                            && channel
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    })
            }),
        _ => false,
    }
}

/// Read each provider database in the home root, one at a time.
pub fn databases(scan: &mut Scan<'_>, home: &Home, epoch: i64) -> Result<()> {
    let entries = match std::fs::read_dir(&home.home_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_at(error, &home.home_dir)),
    };
    let mut paths = Vec::new();
    for entry in entries {
        scan.cancel.check()?;
        let entry = entry.map_err(|e| io_at(e, &home.home_dir))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().is_ok_and(|t| t.is_file()) && is_database(home.provider, &name) {
            paths.push(entry.path());
        }
    }
    for path in paths {
        database(scan, home, epoch, &path)?;
    }
    Ok(())
}

fn database(scan: &mut Scan<'_>, home: &Home, epoch: i64, path: &std::path::Path) -> Result<()> {
    let name = text(path);
    scan.tally.files += 1;
    let fp = match database_fingerprint(path) {
        Ok(fp) => fp,
        Err(Error::Missing(_)) => return Ok(()),
        Err(error) => return Err(error),
    };
    if scan.catalog.touch(&home.id, &name, &fp, epoch)? {
        scan.tally.skipped += 1;
        return Ok(());
    }
    let now = (scan.now)();
    if let Some(reason) = scan
        .catalog
        .backoff
        .waiting(&scan.catalog.db, &home.id, &name, now)?
    {
        // A recent failure keeps the last good rows and its notice.
        scan.catalog.preserve_path(&home.id, &name, epoch)?;
        scan.tally.skipped += 1;
        if !reason.is_empty() {
            scan.tally.unsupported(&home.id, &reason);
        }
        return Ok(());
    }
    let verdict = scan
        .catalog
        .crashes
        .verdict(&home.id, &name, Some(&fp), now);
    if let Verdict::Blocked(reason) = &verdict {
        scan.catalog.preserve_path(&home.id, &name, epoch)?;
        scan.tally.skipped += 1;
        scan.tally.unsupported(&home.id, reason);
        return Ok(());
    }
    // Marked outside the savepoint: a crash must leave the mark durable.
    let mark = if verdict == Verdict::Isolate {
        Mark::Verifying
    } else {
        Mark::Reading
    };
    scan.catalog
        .crashes
        .mark(&scan.catalog.db, &home.id, &name, mark, &fp)?;
    scan.catalog.db.execute_batch("SAVEPOINT provider_scan")?;
    let mut opened = None;
    let outcome = (|| -> Result<()> {
        let db = open_provider_db(home, path, scan.scratch, scan.cancel)?;
        scan.tally.reads += 1;
        let mut rows = 0;
        let mut put = |session: Session, hidden: bool| -> Result<()> {
            rows += 1;
            if rows > 100_000 {
                return Err(Error::message(
                    "Provider database session inventory limit exceeded",
                ));
            }
            if rows % 64 == 0 {
                (scan.progress)(&scan.tally);
            }
            scan.cancel.check()?;
            let titled =
                home.provider == Provider::Codex && !session.title.starts_with("Session from ");
            let (native, title) = (session.native_id.clone(), session.title.clone());
            scan.catalog.put(
                &Source {
                    summary: session,
                    hidden,
                    path: name.clone(),
                    fingerprint: fp.clone(),
                    kind: Kind::Database,
                    instance_id: home.id.clone(),
                },
                epoch,
            )?;
            if titled {
                scan.catalog
                    .set_native_title(&home.id, &native, &title, "database")?;
            }
            Ok(())
        };
        let read = match home.provider {
            Provider::Codex => codex::sessions(home, &name, &db.db, &mut put),
            _ => crate::opencode::sessions::sessions(home, &name, &db.db, &mut put),
        };
        opened = Some(db);
        read?;
        if let Some(db) = &opened {
            db.verify()?;
        }
        // The rows read are one committed state even if the provider committed again since.
        let info = std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?;
        scan.catalog
            .remember(home, &name, info.len(), mtime_ms(&info), &fp, epoch)?;
        scan.catalog
            .backoff
            .succeeded(&scan.catalog.db, &home.id, &name)?;
        Ok(())
    })();
    match &outcome {
        Ok(()) => scan.catalog.db.execute_batch("RELEASE provider_scan")?,
        Err(_) => {
            scan.catalog
                .db
                .execute_batch("ROLLBACK TO provider_scan; RELEASE provider_scan")?;
            scan.catalog.preserve_path(&home.id, &name, epoch)?;
        }
    }
    if let Some(db) = opened {
        db.close();
    }
    scan.catalog
        .crashes
        .finished(&scan.catalog.db, &home.id, &name)?;
    match outcome {
        Ok(()) => Ok(()),
        Err(error) if scan.cancel.is_cancelled() || matches!(error, Error::Aborted) => Err(error),
        Err(error) => {
            let message = error.to_string();
            // A busy snapshot is read by the next scan; a race waits silently.
            if message != BUSY {
                let reason = (message != CHANGED).then_some(message);
                scan.catalog.backoff.failed(
                    &scan.catalog.db,
                    &home.id,
                    &name,
                    reason.as_deref(),
                    (scan.now)(),
                )?;
                if let Some(reason) = reason {
                    scan.tally.unsupported(&home.id, &reason);
                }
            }
            Ok(())
        }
    }
}
