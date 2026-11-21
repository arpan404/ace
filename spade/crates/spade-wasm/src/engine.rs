//! The worker's Wasmtime (ADR 0203 §3, §4): the component model on, every proposal Spade doesn't
//! use off, fuel and epoch interruption on. A call's bounds are kept by its store: an epoch
//! callback each tick checks Stop and the deadline, fuel guards a loop that never yields, and
//! [`Limiter`] bounds memory and tables and records the peak.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use spade_core::package::code::{MOST_TABLES, binary};
use wasmtime::{Config, Engine, ResourceLimiter, WasmFeatures};

use crate::protocol::Cut;

/// How often the epoch ticks: how soon Stop and a deadline are seen while code runs.
pub const TICK: Duration = Duration::from_millis(10);

/// The engine every call of this worker runs on.
pub fn engine() -> wasmtime::Result<Engine> {
    let mut config = Config::new();
    // Exactly the features the check accepts (`spade_core::package::code::binary::features`).
    config.wasm_features(WasmFeatures::all(), false);
    config.wasm_features(binary::features(), true);
    config.wasm_component_model(true);
    config.consume_fuel(true);
    config.epoch_interruption(true);
    // Traps are taken with signals, not a Mach exception port: the sandbox holds a worker with
    // no Mach services, and a port per process is nothing it needs.
    #[cfg(target_os = "macos")]
    config.macos_use_mach_ports(false);
    Engine::new(&config)
}

/// Ticks `engine`'s epoch every [`TICK`] for as long as the engine lives.
pub fn tick(engine: &Engine) {
    let weak = engine.weak();
    std::thread::spawn(move || {
        while let Some(engine) = weak.upgrade() {
            engine.increment_epoch();
            drop(engine);
            std::thread::sleep(TICK);
        }
    });
}

/// Why a call is being cut off, raised from inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cutting(pub Cut);

impl std::fmt::Display for Cutting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.0)
    }
}

impl std::error::Error for Cutting {}

/// Time a call's component has run: paused while it waits on Spade.
#[derive(Debug)]
pub struct Clock {
    spent: Duration,
    since: Option<Instant>,
}

impl Clock {
    pub fn running() -> Self {
        Self {
            spent: Duration::ZERO,
            since: Some(Instant::now()),
        }
    }

    pub fn spent(&self) -> Duration {
        self.spent + self.since.map(|s| s.elapsed()).unwrap_or_default()
    }

    /// Waiting on Spade from now: not counted.
    pub fn pause(&mut self) {
        if let Some(since) = self.since.take() {
            self.spent += since.elapsed();
        }
    }

    /// Running again: the deadline is re-armed from what was spent before the wait.
    pub fn resume(&mut self) {
        if self.since.is_none() {
            self.since = Some(Instant::now());
        }
    }
}

/// A call's memory and tables, bounded. The memory bound holds every linear memory of the call's
/// store together (a component may hold several, one per core instance), and the peak is theirs
/// together too.
#[derive(Debug)]
pub struct Limiter {
    memory: usize,
    /// Every linear memory's size now, summed.
    total: usize,
    pub peak: usize,
}

impl Limiter {
    pub fn new(memory_bytes: u64) -> Self {
        Self {
            memory: usize::try_from(memory_bytes).unwrap_or(usize::MAX),
            total: 0,
            peak: 0,
        }
    }

    /// The bound, in bytes.
    pub fn bound(&self) -> usize {
        self.memory
    }
}

impl ResourceLimiter for Limiter {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        // A memory being made grows from nothing; one growing adds what it grows by. Past the
        // bound, all memories together, the grow traps, so the call ends and says why.
        let total = self.total.saturating_sub(current).saturating_add(desired);
        if total > self.memory {
            return Err(wasmtime::Error::new(Cutting(Cut::Memory)));
        }
        self.total = total;
        self.peak = self.peak.max(total);
        Ok(true)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(desired <= 1_000_000)
    }

    fn instances(&self) -> usize {
        // One component instance per call; its core instances are counted here.
        64
    }

    fn tables(&self) -> usize {
        MOST_TABLES as usize
    }

    fn memories(&self) -> usize {
        16
    }
}

/// What a call's epoch callback reads: whether it was stopped, and its clock and deadline.
pub fn over(stop: &Arc<AtomicBool>, clock: &Clock, deadline: Duration) -> Option<Cut> {
    if stop.load(Ordering::SeqCst) {
        Some(Cut::Stopped)
    } else if clock.spent() > deadline {
        Some(Cut::Deadline)
    } else {
        None
    }
}

/// A failed call's error, as the cut it was.
pub fn cut_of(error: &wasmtime::Error) -> Cut {
    if let Some(Cutting(cut)) = error.downcast_ref::<Cutting>() {
        return *cut;
    }
    match error.downcast_ref::<wasmtime::Trap>() {
        Some(wasmtime::Trap::OutOfFuel) => Cut::Fuel,
        Some(wasmtime::Trap::Interrupt) => Cut::Deadline,
        _ => Cut::Trap,
    }
}
