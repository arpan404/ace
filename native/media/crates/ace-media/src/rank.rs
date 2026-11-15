// SPDX-License-Identifier: Apache-2.0
//! The encoder ranking benchmark (docs/media/plan.md, "Ranking: a separate benchmark"). It
//! applies only where two hardware encoders serve the same GPU (today Media Foundation's NVIDIA
//! MFT and NVENC on Windows). While no source is open, each candidate encodes for a bounded
//! time; a source opening cancels the run at once and its partial result is thrown away. The
//! winner is kept in `<dataDir>/media/encoder-rank.json` per [`RankKey`] (adapter, driver and
//! encode settings), so a driver update makes a new key and the benchmark runs once per key.
//! Before a result exists the choice is deterministic: the first candidate, which callers
//! order as the plan says (the MFT on Windows, NVENC on Linux NVIDIA).
use media_wire::capability::Backend;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// Each candidate's encode run.
pub const CANDIDATE_RUN: Duration = Duration::from_secs(10);
/// The whole ranking, every candidate together.
pub const RANK_TOTAL: Duration = Duration::from_secs(20);

/// What a result is kept under. A driver update or other settings make a new key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RankKey {
    /// PCI vendor and device id.
    pub vendor: u32,
    pub device: u32,
    /// The adapter's LUID (0 where the platform has none).
    pub luid: u64,
    pub driver: String,
    /// The codec family (`avc1`, `hvc1`).
    pub codec: String,
    pub size: SizeBucket,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SizeBucket {
    UpTo720,
    UpTo1080,
    UpTo1440,
    UpTo2160,
    Larger,
}

impl SizeBucket {
    pub fn of(width: u32, height: u32) -> Self {
        let pixels = u64::from(width) * u64::from(height);
        match pixels {
            0..=921_600 => Self::UpTo720,
            921_601..=2_088_960 => Self::UpTo1080,
            2_088_961..=3_686_400 => Self::UpTo1440,
            3_686_401..=8_847_360 => Self::UpTo2160,
            _ => Self::Larger,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::UpTo720 => "720p",
            Self::UpTo1080 => "1080p",
            Self::UpTo1440 => "1440p",
            Self::UpTo2160 => "2160p",
            Self::Larger => "larger",
        }
    }
    fn named(name: &str) -> Option<Self> {
        [
            Self::UpTo720,
            Self::UpTo1080,
            Self::UpTo1440,
            Self::UpTo2160,
            Self::Larger,
        ]
        .into_iter()
        .find(|b| b.name() == name)
    }
}

/// One encoder in the ranking.
pub trait Candidate: Send + 'static {
    fn backend(&self) -> Backend;
    /// Encodes at the key's settings for at most `budget`, returning pictures per second, or
    /// none when it failed. Returns at once, closing its session, once `stop` says so.
    fn run(&mut self, budget: Duration, stop: &dyn Fn() -> bool) -> Option<f64>;
}

/// The kept results: winners per key, decoded leniently (entries it can't read are skipped).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RankCache {
    entries: Vec<(RankKey, Backend)>,
}

impl RankCache {
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join("media").join("encoder-rank.json")
    }

    /// The cache at `path`; empty when it is missing or unreadable.
    pub fn load(path: &Path) -> Self {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let entries = value
            .get("entries")
            .and_then(Value::as_array)
            .map(|entries| entries.iter().filter_map(decode).collect())
            .unwrap_or_default();
        Self { entries }
    }

    /// Writes the cache whole (a temporary file renamed over the old one).
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let entries: Vec<Value> = self.entries.iter().map(encode).collect();
        let text = serde_json::to_string_pretty(&json!({ "version": 1, "entries": entries }))
            .map_err(std::io::Error::other)?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, path)
    }

    /// Every kept result, as the cache file writes it (for `ace doctor`).
    pub fn report(&self) -> Vec<Value> {
        self.entries.iter().map(encode).collect()
    }

    pub fn winner(&self, key: &RankKey) -> Option<Backend> {
        self.entries.iter().find(|(k, _)| k == key).map(|e| e.1)
    }

    pub fn insert(&mut self, key: RankKey, winner: Backend) {
        self.entries.retain(|(k, _)| *k != key);
        self.entries.push((key, winner));
    }
}

fn encode((key, winner): &(RankKey, Backend)) -> Value {
    json!({
        "vendor": key.vendor,
        "device": key.device,
        "luid": key.luid.to_string(),
        "driver": key.driver,
        "codec": key.codec,
        "size": key.size.name(),
        "winner": winner,
    })
}

fn decode(entry: &Value) -> Option<(RankKey, Backend)> {
    let number = |name: &str| entry.get(name)?.as_u64()?.try_into().ok();
    let text = |name: &str| entry.get(name)?.as_str().map(str::to_owned);
    let key = RankKey {
        vendor: number("vendor")?,
        device: number("device")?,
        luid: text("luid")?.parse().ok()?,
        driver: text("driver")?,
        codec: text("codec")?,
        size: SizeBucket::named(&text("size")?)?,
    };
    let winner = serde_json::from_value(entry.get("winner")?.clone()).ok()?;
    Some((key, winner))
}

/// The encoder to use for `key`: the kept winner if it is still a candidate, else the first
/// candidate (the deterministic choice). None without candidates.
pub fn choice(cache: &RankCache, key: &RankKey, candidates: &[Backend]) -> Option<Backend> {
    cache
        .winner(key)
        .filter(|w| candidates.contains(w))
        .or_else(|| candidates.first().copied())
}

/// The best of the candidates' results, the first on a tie; none when every one failed.
fn best(results: &[(Backend, Option<f64>)]) -> Option<Backend> {
    let mut best: Option<(Backend, f64)> = None;
    for &(backend, score) in results {
        if let Some(score) = score.filter(|s| s.is_finite())
            && best.is_none_or(|(_, b)| score > b)
        {
            best = Some((backend, score));
        }
    }
    best.map(|b| b.0)
}

/// Runs the ranking for one key while no source is open. One owner thread holds the state and
/// takes every change as an event, in order: the number of open sources (`sources`, from any
/// [`RankerHandle`]) and each run's result. A run's result is only a proposal: the owner keeps
/// it (cache and `results`) only if that run, by its generation, was never cancelled and no
/// source is open when it arrives. Whenever nothing is open and nothing runs, a run starts,
/// until one has been accepted.
pub struct Ranker {
    handle: RankerHandle,
}

/// Tells the ranker how many sources are open; cheap to clone and send.
#[derive(Clone)]
pub struct RankerHandle(mpsc::Sender<Event>);

impl RankerHandle {
    /// The number of open sources changed: none open starts the ranking, one cancels it.
    pub fn sources(&self, open: usize) {
        let _ = self.0.send(Event::Sources(open));
    }
}

enum Event {
    Sources(usize),
    /// A run returned. `completed`: every candidate ran without being stopped.
    Finished {
        generation: u64,
        candidates: Vec<Box<dyn Candidate>>,
        scores: Vec<(Backend, Option<f64>)>,
        completed: bool,
    },
    Stop,
}

struct Running {
    generation: u64,
    stop: Arc<AtomicBool>,
    cancelled: bool,
}

struct State {
    key: RankKey,
    cache_path: PathBuf,
    budget: (Duration, Duration),
    /// Held while no run has them; none once a run was accepted, or when there is nothing to
    /// rank.
    candidates: Option<Vec<Box<dyn Candidate>>>,
    open: usize,
    generation: u64,
    running: Option<Running>,
    results: mpsc::Sender<Backend>,
    events: mpsc::Sender<Event>,
}

impl Ranker {
    /// A ranker for `key` with `candidates` in deterministic order. It never runs with fewer
    /// than two, or when `cache_path` already holds a winner that is one of them.
    pub fn new(
        key: RankKey,
        candidates: Vec<Box<dyn Candidate>>,
        cache_path: PathBuf,
    ) -> (Self, mpsc::Receiver<Backend>) {
        Self::with_budget(key, candidates, cache_path, CANDIDATE_RUN, RANK_TOTAL)
    }

    /// As `new`, with each candidate's run and the total bounded as given.
    pub fn with_budget(
        key: RankKey,
        candidates: Vec<Box<dyn Candidate>>,
        cache_path: PathBuf,
        per_candidate: Duration,
        total: Duration,
    ) -> (Self, mpsc::Receiver<Backend>) {
        let (results, receiver) = mpsc::channel();
        let (events, inbox) = mpsc::channel();
        // A kept winner counts only if it is still eligible here; any other entry is ignored.
        let ranked = RankCache::load(&cache_path)
            .winner(&key)
            .is_some_and(|winner| candidates.iter().any(|c| c.backend() == winner));
        let state = State {
            key,
            cache_path,
            budget: (per_candidate, total),
            candidates: (candidates.len() >= 2 && !ranked).then_some(candidates),
            // Nothing runs until the first count arrives.
            open: 1,
            generation: 0,
            running: None,
            results,
            events: events.clone(),
        };
        let _ = std::thread::Builder::new()
            .name("media-rank-owner".into())
            .spawn(move || state.serve(&inbox));
        (
            Self {
                handle: RankerHandle(events),
            },
            receiver,
        )
    }

    /// The number of open sources changed.
    pub fn sources(&self, open: usize) {
        self.handle.sources(open);
    }

    pub fn handle(&self) -> RankerHandle {
        self.handle.clone()
    }
}

impl Drop for Ranker {
    fn drop(&mut self) {
        let _ = self.handle.0.send(Event::Stop);
    }
}

impl State {
    fn serve(mut self, inbox: &mpsc::Receiver<Event>) {
        while let Ok(event) = inbox.recv() {
            match event {
                Event::Sources(open) => {
                    self.open = open;
                    if open > 0 {
                        self.cancel();
                    }
                }
                Event::Finished {
                    generation,
                    candidates,
                    scores,
                    completed,
                } => self.finished(generation, candidates, &scores, completed),
                Event::Stop => {
                    self.cancel();
                    return;
                }
            }
            if self.open == 0 && self.running.is_none() {
                self.start();
            }
        }
    }

    fn cancel(&mut self) {
        if let Some(running) = &mut self.running {
            running.cancelled = true;
            running.stop.store(true, Ordering::SeqCst);
        }
    }

    fn finished(
        &mut self,
        generation: u64,
        candidates: Vec<Box<dyn Candidate>>,
        scores: &[(Backend, Option<f64>)],
        completed: bool,
    ) {
        let Some(running) = self.running.take_if(|r| r.generation == generation) else {
            return;
        };
        if running.cancelled || !completed || self.open > 0 {
            // Thrown away; the candidates wait for the next idle time.
            self.candidates = Some(candidates);
            return;
        }
        // Accepted. Every candidate failing keeps the deterministic choice, and is not retried.
        if let Some(winner) = best(scores) {
            let mut cache = RankCache::load(&self.cache_path);
            cache.insert(self.key.clone(), winner);
            let _ = cache.save(&self.cache_path);
            let _ = self.results.send(winner);
        }
    }

    fn start(&mut self) {
        let Some(mut candidates) = self.candidates.take() else {
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let events = self.events.clone();
        let (per_candidate, total) = self.budget;
        let spawned = std::thread::Builder::new()
            .name("media-rank".into())
            .spawn(move || {
                let each = per_candidate.min(total / candidates.len().max(1) as u32);
                let stopped = || flag.load(Ordering::SeqCst);
                let mut scores = Vec::with_capacity(candidates.len());
                for candidate in &mut candidates {
                    if stopped() {
                        break;
                    }
                    scores.push((candidate.backend(), candidate.run(each, &stopped)));
                }
                let completed = scores.len() == candidates.len() && !stopped();
                let _ = events.send(Event::Finished {
                    generation,
                    candidates,
                    scores,
                    completed,
                });
            });
        if spawned.is_ok() {
            self.running = Some(Running {
                generation,
                stop,
                cancelled: false,
            });
        }
    }
}

#[cfg(test)]
#[path = "rank_tests.rs"]
mod tests;
