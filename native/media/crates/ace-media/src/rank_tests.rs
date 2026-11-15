// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::sync::Mutex;
use std::time::Instant;

fn key(driver: &str) -> RankKey {
    RankKey {
        vendor: 0x10de,
        device: 0x2684,
        luid: 0x0000_0001_0000_beef,
        driver: driver.into(),
        codec: "avc1".into(),
        size: SizeBucket::of(1920, 1080),
    }
}

/// A scripted candidate: a score after `takes`, or blocking until stopped.
struct Fake {
    backend: Backend,
    score: Option<f64>,
    takes: Duration,
    runs: Arc<Mutex<Vec<(Backend, Duration, bool)>>>,
}

impl Candidate for Fake {
    fn backend(&self) -> Backend {
        self.backend
    }
    fn run(&mut self, budget: Duration, stop: &dyn Fn() -> bool) -> Option<f64> {
        let started = Instant::now();
        while started.elapsed() < self.takes.min(budget) {
            if stop() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let stopped = stop();
        if let Ok(mut runs) = self.runs.lock() {
            runs.push((self.backend, budget, stopped));
        }
        self.score
    }
}

type Runs = Arc<Mutex<Vec<(Backend, Duration, bool)>>>;

fn pair(mft: Option<f64>, nvenc: Option<f64>, takes: Duration) -> (Vec<Box<dyn Candidate>>, Runs) {
    let runs: Runs = Arc::default();
    let fake = |backend, score| -> Box<dyn Candidate> {
        Box::new(Fake {
            backend,
            score,
            takes,
            runs: runs.clone(),
        })
    };
    (vec![fake(Backend::Mf, mft), fake(Backend::Nv, nvenc)], runs)
}

fn temp_cache(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ace-rank-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    RankCache::path(&dir)
}

#[test]
fn without_a_result_the_choice_is_the_deterministic_first_candidate() {
    let cache = RankCache::default();
    assert_eq!(
        choice(&cache, &key("560.94"), &[Backend::Mf, Backend::Nv]),
        Some(Backend::Mf)
    );
    assert_eq!(
        choice(&cache, &key("560.94"), &[Backend::Nv]),
        Some(Backend::Nv)
    );
    assert_eq!(choice(&cache, &key("560.94"), &[]), None);
}

#[test]
fn the_ranking_runs_while_no_source_is_open_and_keeps_the_winner_per_key() {
    let path = temp_cache("keeps");
    let (candidates, runs) = pair(Some(240.0), Some(410.0), Duration::from_millis(20));
    let (ranker, results) = Ranker::with_budget(
        key("560.94"),
        candidates,
        path.clone(),
        CANDIDATE_RUN,
        RANK_TOTAL,
    );
    ranker.sources(0);
    assert_eq!(
        results.recv_timeout(Duration::from_secs(5)),
        Ok(Backend::Nv)
    );
    let cache = RankCache::load(&path);
    assert_eq!(
        choice(&cache, &key("560.94"), &[Backend::Mf, Backend::Nv]),
        Some(Backend::Nv)
    );
    // Every candidate ran within its share of the 20 s total.
    let budgets: Vec<_> = runs.lock().map(|r| r.clone()).unwrap_or_default();
    assert_eq!(budgets.len(), 2);
    assert!(budgets.iter().all(|r| r.1 <= CANDIDATE_RUN && !r.2));
    assert!(budgets.iter().map(|r| r.1).sum::<Duration>() <= RANK_TOTAL);

    // Once per key: the same key never runs again; a driver update makes a new key.
    let (candidates, runs) = pair(Some(1.0), Some(2.0), Duration::ZERO);
    let (again, results) = Ranker::with_budget(
        key("560.94"),
        candidates,
        path.clone(),
        CANDIDATE_RUN,
        RANK_TOTAL,
    );
    again.sources(0);
    assert!(results.recv_timeout(Duration::from_millis(200)).is_err());
    assert!(runs.lock().map(|r| r.is_empty()).unwrap_or(false));
    let (candidates, _) = pair(Some(9.0), Some(2.0), Duration::ZERO);
    let (updated, results) = Ranker::with_budget(
        key("566.03"),
        candidates,
        path.clone(),
        CANDIDATE_RUN,
        RANK_TOTAL,
    );
    updated.sources(0);
    assert_eq!(
        results.recv_timeout(Duration::from_secs(5)),
        Ok(Backend::Mf)
    );
    let cache = RankCache::load(&path);
    assert_eq!(cache.winner(&key("560.94")), Some(Backend::Nv));
    assert_eq!(cache.winner(&key("566.03")), Some(Backend::Mf));
}

#[test]
fn a_source_opening_cancels_the_ranking_at_once_and_keeps_no_result() {
    let path = temp_cache("cancel");
    let (candidates, runs) = pair(Some(1.0), Some(2.0), Duration::from_secs(30));
    let (ranker, results) = Ranker::new(key("560.94"), candidates, path.clone());
    ranker.sources(0);
    std::thread::sleep(Duration::from_millis(50));
    let cancelled = Instant::now();
    ranker.sources(1);
    let deadline = Instant::now() + Duration::from_secs(2);
    while runs.lock().map(|r| r.is_empty()).unwrap_or(true) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(cancelled.elapsed() < Duration::from_millis(500));
    let ran: Vec<_> = runs.lock().map(|r| r.clone()).unwrap_or_default();
    assert_eq!(ran.len(), 1, "the second candidate never started");
    assert!(ran[0].2, "the first saw the stop");
    assert!(results.recv_timeout(Duration::from_millis(100)).is_err());
    assert_eq!(RankCache::load(&path).winner(&key("560.94")), None);
}

#[test]
fn the_ranking_never_starts_while_a_source_is_open_and_resumes_once_idle() {
    let path = temp_cache("idle");
    let (candidates, runs) = pair(Some(5.0), Some(1.0), Duration::ZERO);
    let (ranker, results) =
        Ranker::with_budget(key("560.94"), candidates, path, CANDIDATE_RUN, RANK_TOTAL);
    ranker.sources(2);
    ranker.sources(1);
    std::thread::sleep(Duration::from_millis(50));
    assert!(runs.lock().map(|r| r.is_empty()).unwrap_or(false));
    ranker.sources(0);
    assert_eq!(
        results.recv_timeout(Duration::from_secs(5)),
        Ok(Backend::Mf)
    );
}

#[test]
fn a_single_candidate_or_failing_candidates_keep_the_deterministic_choice() {
    let path = temp_cache("single");
    let (mut candidates, runs) = pair(None, None, Duration::ZERO);
    candidates.truncate(1);
    let (ranker, results) = Ranker::new(key("560.94"), candidates, path.clone());
    ranker.sources(0);
    assert!(results.recv_timeout(Duration::from_millis(100)).is_err());
    assert!(runs.lock().map(|r| r.is_empty()).unwrap_or(false));

    let (candidates, _) = pair(None, Some(f64::NAN), Duration::ZERO);
    let (ranker, results) = Ranker::new(key("560.94"), candidates, path.clone());
    ranker.sources(0);
    assert!(results.recv_timeout(Duration::from_millis(300)).is_err());
    let cache = RankCache::load(&path);
    assert_eq!(
        choice(&cache, &key("560.94"), &[Backend::Mf, Backend::Nv]),
        Some(Backend::Mf)
    );
}

#[test]
fn an_unreadable_cache_or_entry_is_skipped_not_fatal() {
    let path = temp_cache("lenient");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        &path,
        r#"{"version":2,"entries":[{"vendor":"x"},{"vendor":4318,"device":9860,"luid":"4295016175","driver":"560.94","codec":"avc1","size":"1080p","winner":"nv","later":true}]}"#,
    );
    assert_eq!(
        RankCache::load(&path).winner(&key("560.94")),
        Some(Backend::Nv)
    );
    let _ = std::fs::write(&path, "not json");
    assert_eq!(RankCache::load(&path), RankCache::default());
}

/// Scripted per run: blocks until stopped and then takes `after_stop` to return (its first run
/// only), and calls `on_run` (its first run only) before returning its score.
struct Slow {
    backend: Backend,
    score: f64,
    after_stop: Duration,
    runs: Arc<Mutex<u32>>,
    on_run: Option<Box<dyn FnOnce() + Send>>,
    block_first: bool,
}

impl Candidate for Slow {
    fn backend(&self) -> Backend {
        self.backend
    }
    fn run(&mut self, _budget: Duration, stop: &dyn Fn() -> bool) -> Option<f64> {
        let first = self.runs.lock().map(|mut n| {
            *n += 1;
            *n == 1
        });
        if first.unwrap_or(false) && self.block_first {
            while !stop() {
                std::thread::sleep(Duration::from_millis(5));
            }
            std::thread::sleep(self.after_stop);
        }
        if let Some(on_run) = self.on_run.take() {
            on_run();
        }
        Some(self.score)
    }
}

fn slow(backend: Backend, score: f64, block_first: bool) -> (Slow, Arc<Mutex<u32>>) {
    let runs: Arc<Mutex<u32>> = Arc::default();
    let candidate = Slow {
        backend,
        score,
        after_stop: Duration::from_millis(200),
        runs: runs.clone(),
        on_run: None,
        block_first,
    };
    (candidate, runs)
}

fn wait_for(what: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !what() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_source_that_closes_before_the_cancelled_run_returns_still_gets_the_ranking_restarted() {
    let path = temp_cache("restart");
    let (mft, mft_runs) = slow(Backend::Mf, 1.0, true);
    let (nvenc, _) = slow(Backend::Nv, 2.0, false);
    let (ranker, results) = Ranker::new(
        key("560.94"),
        vec![Box::new(mft), Box::new(nvenc)],
        path.clone(),
    );
    ranker.sources(0);
    wait_for(|| mft_runs.lock().map(|n| *n == 1).unwrap_or(false));
    // Opens and closes again while the first candidate is still winding down from the stop.
    ranker.sources(1);
    ranker.sources(0);
    assert_eq!(
        results.recv_timeout(Duration::from_secs(5)),
        Ok(Backend::Nv),
        "the ranking ran again once idle"
    );
    assert_eq!(
        RankCache::load(&path).winner(&key("560.94")),
        Some(Backend::Nv)
    );
}

#[test]
fn a_run_cancelled_after_its_candidates_finished_keeps_and_publishes_nothing() {
    let path = temp_cache("late-cancel");
    let (mft, _) = slow(Backend::Mf, 1.0, false);
    let (mut nvenc, _) = slow(Backend::Nv, 2.0, false);
    let handle: Arc<Mutex<Option<RankerHandle>>> = Arc::default();
    let opener = handle.clone();
    // The last candidate's score is in, but a source opens before the run is accepted.
    nvenc.on_run = Some(Box::new(move || {
        if let Ok(Some(handle)) = opener.lock().map(|h| h.clone()) {
            handle.sources(1);
        }
    }));
    let (ranker, results) = Ranker::new(
        key("560.94"),
        vec![Box::new(mft), Box::new(nvenc)],
        path.clone(),
    );
    if let Ok(mut slot) = handle.lock() {
        *slot = Some(ranker.handle());
    }
    ranker.sources(0);
    assert!(results.recv_timeout(Duration::from_millis(500)).is_err());
    assert_eq!(RankCache::load(&path).winner(&key("560.94")), None);
    // Idle again: the next run is accepted.
    ranker.sources(0);
    assert_eq!(
        results.recv_timeout(Duration::from_secs(5)),
        Ok(Backend::Nv)
    );
}

#[test]
fn a_kept_winner_that_is_not_a_candidate_here_does_not_count_as_ranked() {
    let path = temp_cache("ineligible");
    let mut cache = RankCache::default();
    cache.insert(key("560.94"), Backend::Cpu);
    let _ = cache.save(&path);
    let (candidates, _) = pair(Some(3.0), Some(1.0), Duration::ZERO);
    let (ranker, results) = Ranker::new(key("560.94"), candidates, path.clone());
    ranker.sources(0);
    assert_eq!(
        results.recv_timeout(Duration::from_secs(5)),
        Ok(Backend::Mf)
    );
    assert_eq!(
        RankCache::load(&path).winner(&key("560.94")),
        Some(Backend::Mf)
    );
}
