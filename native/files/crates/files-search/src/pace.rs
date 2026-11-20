// SPDX-License-Identifier: Apache-2.0

//! How many walker threads search at once on macOS, chosen while the search runs.
//!
//! macOS serializes much of `open(2)` inside the kernel. While a tree's files are in memory, a
//! walker thread spends nearly all its time on the CPU, and past four threads each one mostly
//! spins on the others: on a 16-core Mac, a 200,000-file tree took 1.4 s with four threads and
//! 6 s with twelve. A tree with more entries than the kernel keeps vnodes for (`kern.maxvnodes`,
//! about 260,000 on that Mac) cannot stay in memory, so its files are read from the disk, a thread
//! mostly waits, and more threads keep more reads in flight: a million-file tree took 23.6 s with
//! four threads and 11 s with ten. Past about ten the kernel's locks win again, even there.
//!
//! So the walk starts every thread it may use (`walk::MAX_THREADS`), and lets [`START`] of them run. Each running thread
//! adds the CPU time it used to a shared count, and about every [`WINDOW`] that count is compared
//! with the time the running threads had: threads that were mostly waiting are joined by more,
//! threads that were mostly on the CPU are not, and a crowd that is all on the CPU shrinks back.
//! The others wait in [`Paced::wait`] at the start of their next entry. A waiting thread holds the
//! entry the walk gave it, which may be a folder no other thread will see, so it also goes on as
//! soon as the running threads stop making progress: the walk can never stall on a parked thread.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How many threads run when a search starts: the count that is fastest over a tree in memory.
pub(crate) const START: usize = 4;

/// How long the running threads are measured before the count is reconsidered.
const WINDOW: Duration = Duration::from_millis(100);

/// How many entries a running thread handles between two looks at its own CPU time.
const CHECK_EVERY: u32 = 64;

/// How long a parked thread waits for progress before it decides the walk needs it.
const STALL: Duration = Duration::from_millis(2);

/// Below this share of their time on the CPU, the running threads are mostly waiting on the disk.
const WAITING: f64 = 0.6;

/// Above this share, the running threads are all on the CPU and more of them only contend.
const CROWDED: f64 = 0.9;

/// How many threads join, or leave, at one decision.
const STEP: usize = 4;

/// The thread count after one window, from the share of the running threads' time spent on the
/// CPU: more when they were mostly waiting, fewer when they were all busy, never below
/// [`START`] or above `threads`.
pub(crate) fn next_limit(limit: usize, on_cpu: f64, threads: usize) -> usize {
    let floor = START.min(threads);
    let next = if on_cpu < WAITING {
        limit.saturating_add(STEP)
    } else if on_cpu > CROWDED {
        limit.saturating_sub(STEP)
    } else {
        limit
    };
    next.clamp(floor, threads.max(floor))
}

/// The share of the running threads' time they spent on the CPU over one window.
fn on_cpu(cpu: Duration, elapsed: Duration, running: usize) -> f64 {
    let available = elapsed.as_secs_f64() * running.max(1) as f64;
    if available <= 0.0 {
        return 1.0;
    }
    cpu.as_secs_f64() / available
}

/// The window being measured.
struct Window {
    started: Instant,
    cpu_at_start: u64,
}

/// The shared count of threads allowed to run, and what decides it.
pub(crate) struct Pace {
    threads: usize,
    limit: AtomicUsize,
    ids: AtomicUsize,
    /// Entries handled by running threads; a parked thread watches it to see the walk moving.
    progress: AtomicU64,
    /// CPU time the running threads reported, in nanoseconds.
    cpu: AtomicU64,
    window: Mutex<Window>,
    parked: Mutex<()>,
    wake: Condvar,
}

impl Pace {
    /// Pacing for a walk of `threads` threads.
    pub(crate) fn new(threads: usize) -> Pace {
        Pace {
            threads,
            limit: AtomicUsize::new(START.min(threads)),
            ids: AtomicUsize::new(0),
            progress: AtomicU64::new(0),
            cpu: AtomicU64::new(0),
            window: Mutex::new(Window {
                started: Instant::now(),
                cpu_at_start: 0,
            }),
            parked: Mutex::new(()),
            wake: Condvar::new(),
        }
    }

    /// The pacing one walker thread follows. Its place in line is taken at its first entry: the
    /// walk also builds a visitor for the root that never sees an entry, and it must not hold
    /// one of the places that run.
    pub(crate) fn join(&self) -> Paced<'_> {
        Paced {
            pace: self,
            id: None,
            handled: 0,
            cpu_seen: None,
        }
    }

    /// How many threads may run now.
    #[cfg(test)]
    pub(crate) fn limit(&self) -> usize {
        self.limit.load(Ordering::Relaxed)
    }

    /// Reconsiders the count once a window has passed. Only one thread decides at a time; the
    /// others carry on.
    fn reconsider(&self, now: Instant) {
        let Ok(mut window) = self.window.try_lock() else {
            return;
        };
        let elapsed = now.saturating_duration_since(window.started);
        if elapsed < WINDOW {
            return;
        }
        let cpu = self.cpu.load(Ordering::Relaxed);
        let used = Duration::from_nanos(cpu.saturating_sub(window.cpu_at_start));
        let limit = self.limit.load(Ordering::Relaxed);
        let next = next_limit(limit, on_cpu(used, elapsed, limit), self.threads);
        *window = Window {
            started: now,
            cpu_at_start: cpu,
        };
        if next != limit {
            self.limit.store(next, Ordering::Relaxed);
            if next > limit {
                // Hold the lock the parked threads wait under, so none misses the word.
                drop(self.parked.lock().unwrap_or_else(PoisonError::into_inner));
                self.wake.notify_all();
            }
        }
    }
}

/// One walker thread's place in the pacing.
pub(crate) struct Paced<'a> {
    pace: &'a Pace,
    /// This thread's place in line, from its first entry: the first `limit` places run.
    id: Option<usize>,
    handled: u32,
    /// This thread's CPU time when it last reported it.
    cpu_seen: Option<Duration>,
}

impl Paced<'_> {
    /// Called before each entry: returns at once while this thread may run, and otherwise waits
    /// until it may, the running threads stop making progress, or `halted` says the search is over.
    pub(crate) fn wait(&mut self, halted: impl Fn() -> bool) {
        let pace = self.pace;
        let id = *self.id.get_or_insert_with(|| {
            self.cpu_seen = thread_cpu();
            pace.ids.fetch_add(1, Ordering::Relaxed)
        });
        if id >= pace.limit.load(Ordering::Relaxed) {
            self.park(id, &halted);
            // Time spent parked is not time this thread had to search with.
            self.cpu_seen = thread_cpu();
        }
        pace.progress.fetch_add(1, Ordering::Relaxed);
        self.handled += 1;
        if self.handled >= CHECK_EVERY {
            self.handled = 0;
            self.report();
            pace.reconsider(Instant::now());
        }
    }

    fn park(&self, id: usize, halted: &impl Fn() -> bool) {
        let pace = self.pace;
        let mut guard = pace.parked.lock().unwrap_or_else(PoisonError::into_inner);
        while id >= pace.limit.load(Ordering::Relaxed) && !halted() {
            let before = pace.progress.load(Ordering::Relaxed);
            guard = pace
                .wake
                .wait_timeout(guard, STALL)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
            if pace.progress.load(Ordering::Relaxed) == before {
                // Nothing moved: the running threads are out of work, and this entry may be the
                // rest of the walk.
                return;
            }
        }
    }

    /// Adds the CPU time this thread used since it last said.
    fn report(&mut self) {
        let now = thread_cpu();
        if let (Some(now), Some(seen)) = (now, self.cpu_seen) {
            let used = now.saturating_sub(seen);
            self.pace.cpu.fetch_add(
                u64::try_from(used.as_nanos()).unwrap_or(u64::MAX),
                Ordering::Relaxed,
            );
        }
        self.cpu_seen = now;
    }
}

/// The CPU time the calling thread has used, user and system together.
#[cfg(unix)]
#[allow(unsafe_code)]
fn thread_cpu() -> Option<Duration> {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `time` is a valid, writable timespec for the duration of the call, and the clock id
    // is one every supported unix defines.
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &raw mut time) } != 0 {
        return None;
    }
    Some(Duration::new(
        u64::try_from(time.tv_sec).ok()?,
        u32::try_from(time.tv_nsec).ok()?,
    ))
}

/// No thread clock: every window reads as busy, so the count stays at [`START`].
#[cfg(not(unix))]
fn thread_cpu() -> Option<Duration> {
    None
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{Pace, START, next_limit};

    #[test]
    fn threads_mostly_waiting_on_the_disk_are_joined_by_more() {
        assert_eq!(next_limit(4, 0.35, 12), 8);
        assert_eq!(next_limit(8, 0.4, 12), 12);
        assert_eq!(next_limit(12, 0.4, 12), 12, "never more than the walk has");
    }

    #[test]
    fn threads_all_on_the_cpu_are_not_joined_and_a_crowd_shrinks() {
        assert_eq!(next_limit(4, 0.98, 12), 4, "never fewer than the start");
        assert_eq!(next_limit(12, 0.97, 12), 8);
        assert_eq!(
            next_limit(8, 0.75, 12),
            8,
            "between the two, the count holds"
        );
    }

    #[test]
    fn a_walk_with_few_threads_runs_them_all() {
        assert_eq!(next_limit(2, 0.1, 2), 2);
        assert_eq!(next_limit(2, 1.0, 2), 2);
        assert_eq!(Pace::new(2).limit(), 2);
    }

    #[test]
    fn a_parked_thread_goes_on_once_the_running_ones_stop_moving() {
        // The running thread never comes back: its work is done, and the parked thread's entry
        // may be the rest of the walk.
        let pace = Pace::new(START + 1);
        let mut running: Vec<_> = (0..START).map(|_| pace.join()).collect();
        for paced in &mut running {
            paced.wait(|| false);
        }
        let mut parked = pace.join();
        let started = Instant::now();
        parked.wait(|| false);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "a parked thread waited {:?} on a walk that had stopped",
            started.elapsed()
        );
    }
}
