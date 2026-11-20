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
//! A thread takes a turn before it searches a file and gives it back when the file is done; while
//! as many turns are out as the limit allows, the others wait in [`Paced::wait`], holding the file
//! the walk gave them. Folders never wait, so no subtree is held back. A waiting thread looks again
//! every [`RETRY`] rather than being woken by each finished file, which on a tree in memory would
//! cost a wake-up per file; when the running threads run out of work their turns come back and the
//! waiting ones take them, so the walk never stalls.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How many threads run when a search starts: the count that is fastest over a tree in memory.
pub(crate) const START: usize = 4;

/// How long the running threads are measured before the count is reconsidered.
const WINDOW: Duration = Duration::from_millis(100);

/// How many entries a running thread handles between two looks at its own CPU time.
const CHECK_EVERY: u32 = 64;

/// How long a waiting thread waits before it looks for a free turn again.
const RETRY: Duration = Duration::from_millis(1);

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
    /// Threads searching a file now; never more than `limit` when one starts.
    searching: AtomicUsize,
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
            searching: AtomicUsize::new(0),
            cpu: AtomicU64::new(0),
            window: Mutex::new(Window {
                started: Instant::now(),
                cpu_at_start: 0,
            }),
            parked: Mutex::new(()),
            wake: Condvar::new(),
        }
    }

    /// The pacing one walker thread follows.
    pub(crate) fn join(&self) -> Paced<'_> {
        Paced {
            pace: self,
            handled: 0,
            cpu_seen: None,
        }
    }

    /// Takes a turn if fewer threads are searching than the limit allows.
    fn try_take(&self) -> bool {
        let mut searching = self.searching.load(Ordering::Acquire);
        loop {
            if searching >= self.limit.load(Ordering::Acquire) {
                return false;
            }
            match self.searching.compare_exchange_weak(
                searching,
                searching + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(now) => searching = now,
            }
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
    handled: u32,
    /// This thread's CPU time when it last reported it.
    cpu_seen: Option<Duration>,
}

/// A turn to search one file, given back when dropped.
pub(crate) struct Turn<'a> {
    /// `None` when the search ended before a turn came free.
    pace: Option<&'a Pace>,
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        if let Some(pace) = self.pace {
            pace.searching.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

impl<'a> Paced<'a> {
    /// Called before each file: takes a turn, waiting while as many threads are searching as the
    /// limit allows, or until `halted` says the search is over.
    pub(crate) fn wait(&mut self, halted: impl Fn() -> bool) -> Turn<'a> {
        let pace = self.pace;
        if self.cpu_seen.is_none() {
            self.cpu_seen = thread_cpu();
        }
        if !pace.try_take() {
            if !self.park(&halted) {
                return Turn { pace: None };
            }
            // Time spent waiting is not time this thread had to search with.
            self.cpu_seen = thread_cpu();
        }
        self.handled += 1;
        if self.handled >= CHECK_EVERY {
            self.handled = 0;
            self.report();
            pace.reconsider(Instant::now());
        }
        Turn { pace: Some(pace) }
    }

    /// Waits for a free turn and takes it; false when the search ended first.
    fn park(&self, halted: &impl Fn() -> bool) -> bool {
        let pace = self.pace;
        let mut guard = pace.parked.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if halted() {
                return false;
            }
            if pace.try_take() {
                return true;
            }
            guard = pace
                .wake
                .wait_timeout(guard, RETRY)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
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
    fn a_waiting_thread_takes_the_turn_a_finished_one_gives_back() {
        let pace = Pace::new(START + 1);
        let mut running: Vec<_> = (0..START).map(|_| pace.join()).collect();
        let turns: Vec<_> = running
            .iter_mut()
            .map(|paced| paced.wait(|| false))
            .collect();
        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| {
                let mut paced = pace.join();
                let turn = paced.wait(|| false);
                (Instant::now(), turn.pace.is_some())
            });
            std::thread::sleep(Duration::from_millis(50));
            let released = Instant::now();
            drop(turns);
            let (started, took) = waiting.join().unwrap_or((released, false));
            assert!(took, "the waiting thread never got a turn");
            assert!(
                started >= released,
                "a fifth thread searched while four turns were out"
            );
            assert!(
                started.duration_since(released) < Duration::from_secs(1),
                "the waiting thread stayed parked after the turns came back"
            );
        });
    }

    #[test]
    fn a_waiting_thread_gives_up_when_the_search_ends() {
        let pace = Pace::new(START + 1);
        let mut running: Vec<_> = (0..START).map(|_| pace.join()).collect();
        let _turns: Vec<_> = running
            .iter_mut()
            .map(|paced| paced.wait(|| false))
            .collect();
        let mut waiting = pace.join();
        assert!(waiting.wait(|| true).pace.is_none());
    }
}

#[cfg(test)]
mod limit_tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use super::Pace;

    #[test]
    fn threads_busy_on_the_cpu_never_let_more_in_than_the_limit() {
        // Every file takes longer than a parked thread's patience, and keeps its thread on the
        // CPU: nothing may read that as a stalled walk and let the parked threads in.
        let pace = Pace::new(8);
        let inside = AtomicUsize::new(0);
        let most = AtomicUsize::new(0);
        let highest_limit = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    let mut paced = pace.join();
                    for _ in 0..20 {
                        let _turn = paced.wait(|| false);
                        highest_limit.fetch_max(pace.limit(), Ordering::Relaxed);
                        let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                        most.fetch_max(now, Ordering::Relaxed);
                        let until = Instant::now() + Duration::from_millis(3);
                        while Instant::now() < until {
                            std::hint::spin_loop();
                        }
                        inside.fetch_sub(1, Ordering::SeqCst);
                    }
                });
            }
        });
        let (most, limit) = (most.into_inner(), highest_limit.into_inner());
        assert!(
            most <= limit,
            "{most} threads searched at once under a limit of at most {limit}"
        );
    }
}
