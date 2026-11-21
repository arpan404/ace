// SPDX-License-Identifier: Apache-2.0

//! A time budget for each step of a provider-database read. SQLite returns control only between
//! rows, so a query that never yields one (a crafted schema, a pathological plan) would hold the
//! reader forever; a progress handler interrupts it once the step runs past its budget or the
//! operation is cancelled. Readers renew the budget as rows arrive.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::cancel::Cancel;
use crate::error::Result;

/// How long one step of a provider-database read may run without returning a row.
pub const STEP: Duration = Duration::from_secs(60);
/// SQLite virtual-machine instructions between checks: cheap, and well under a millisecond.
const CHECK_EVERY: i32 = 10_000;

/// The message an interrupted step fails with.
pub const OVERRAN: &str = "A saved-history database query ran past its time limit and was stopped; it is read again when the database changes";

#[derive(Clone)]
pub struct StepBudget {
    start: Instant,
    limit: Duration,
    /// Milliseconds since `start` by which the current step must return.
    deadline: Arc<AtomicU64>,
}

impl StepBudget {
    /// Install the budget on `db`; the first step starts now.
    pub fn install(db: &mut Connection, cancel: &Cancel, limit: Duration) -> Result<StepBudget> {
        let budget = StepBudget {
            start: Instant::now(),
            limit,
            deadline: Arc::new(AtomicU64::new(0)),
        };
        budget.renew();
        let (watch, cancel) = (budget.clone(), cancel.clone());
        db.progress_handler(
            CHECK_EVERY,
            Some(move || cancel.is_cancelled() || watch.overran()),
        )?;
        Ok(budget)
    }

    fn elapsed(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn overran(&self) -> bool {
        self.elapsed() > self.deadline.load(Ordering::Relaxed)
    }

    /// A row arrived: the next step gets a whole budget.
    pub fn renew(&self) {
        let limit = u64::try_from(self.limit.as_millis()).unwrap_or(u64::MAX);
        self.deadline
            .store(self.elapsed().saturating_add(limit), Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    const ENDLESS: &str =
        "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r";

    #[test]
    fn a_step_that_never_returns_a_row_is_interrupted_within_its_budget() {
        let mut db = Connection::open_in_memory().unwrap();
        StepBudget::install(&mut db, &Cancel::new(), Duration::from_millis(100)).unwrap();
        let started = Instant::now();
        let outcome: rusqlite::Result<i64> = db.query_row(ENDLESS, [], |r| r.get(0));
        assert!(outcome.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_cancelled_operation_interrupts_its_running_step() {
        let mut db = Connection::open_in_memory().unwrap();
        let cancel = Cancel::new();
        StepBudget::install(&mut db, &cancel, Duration::from_secs(3600)).unwrap();
        let stopper = cancel.clone();
        let timer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            stopper.cancel();
        });
        let started = Instant::now();
        assert!(db.query_row(ENDLESS, [], |r| r.get::<_, i64>(0)).is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
        timer.join().unwrap();
    }
}
