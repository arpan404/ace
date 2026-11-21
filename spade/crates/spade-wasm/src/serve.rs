//! The worker (ADR 0203 §3): reads Spade's frames on stdin and answers on stdout. Each load
//! compiles a component it checked first; each call runs on a thread of its own, in a store of its
//! own holding one instance, with its time, fuel and memory bounded. Stop raises the call's flag,
//! which the next epoch tick sees, and wakes a call waiting on Spade. When Spade's end of the pipe
//! closes, the worker exits, ending every call with it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use spade_core::package::code;
use wasmtime::component::{Component, InstancePre, Linker};
use wasmtime::{Engine, Store, UpdateDeadline};

use crate::engine::{self, Cutting, cut_of, over};
use crate::frame;
use crate::host::{self, CallEvent, CallState, Out};
use crate::protocol::{Cut, FromWorker, Stats, Target, ToWorker};

/// At most this many calls at once per bot (ADR 0203 §4).
pub const MOST_CALLS: usize = 4;

/// The Wasmtime this worker runs, as `Ready` reports it.
pub const WASMTIME: &str = "48.0.10";

/// A loaded component: ready to instantiate, and the name of its `toolbox` export.
struct Loaded {
    pre: InstancePre<CallState>,
    toolbox: String,
}

/// An open call: how Spade's frames reach it.
struct Open {
    events: Sender<CallEvent>,
    stop: Arc<AtomicBool>,
}

struct Worker {
    engine: Engine,
    linker: Arc<Linker<CallState>>,
    out: Out,
    loaded: Arc<Mutex<HashMap<String, Arc<Loaded>>>>,
    open: Arc<Mutex<HashMap<u64, Open>>>,
    base: Instant,
}

/// Serves Spade on `input` and `output` until the pipe closes. Exit code 0 then; 1 when the
/// engine can't start or a frame is unreadable.
pub fn serve(mut input: impl Read, output: impl Write + Send + 'static) -> i32 {
    let out: Out = Arc::new(Mutex::new(Box::new(output)));
    let worker = match start(out) {
        Ok(worker) => worker,
        Err(error) => {
            eprintln!("spade-wasm: the engine didn't start: {error}");
            return 1;
        }
    };
    loop {
        match frame::read::<ToWorker>(&mut input) {
            Ok(Some(message)) => worker.handle(message),
            Ok(None) => return 0,
            Err(error) => {
                eprintln!("spade-wasm: {error}");
                return 1;
            }
        }
    }
}

fn start(out: Out) -> wasmtime::Result<Worker> {
    let engine = engine::engine()?;
    engine::tick(&engine);
    let mut linker = Linker::new(&engine);
    host::link(&mut linker)?;
    let worker = Worker {
        engine,
        linker: Arc::new(linker),
        out,
        loaded: Arc::default(),
        open: Arc::default(),
        base: Instant::now(),
    };
    worker.send(&FromWorker::Ready {
        wasmtime: WASMTIME.to_owned(),
    });
    Ok(worker)
}

/// Sends `message`. A call's answer too large for the pipe is sent as a small failure instead,
/// so the call reads failed and never waits for an answer that can't come. A pipe that broke
/// ends the worker: Spade reads its open calls as stopped or lost.
fn send(out: &Out, message: &FromWorker) {
    let Ok(mut out) = out.lock() else {
        std::process::exit(1);
    };
    match frame::write(&mut *out, message) {
        Ok(()) => {}
        Err(error) if frame::too_large(&error) => {
            let small = match message {
                FromWorker::Done { id, stats, .. } | FromWorker::Failed { id, stats, .. } => {
                    FromWorker::Failed {
                        id: *id,
                        cut: Cut::Trap,
                        message: TOO_LARGE.to_owned(),
                        stats: *stats,
                        logs: Vec::new(),
                    }
                }
                FromWorker::LoadFailed { component, .. } | FromWorker::Loaded { component } => {
                    FromWorker::LoadFailed {
                        component: component.clone(),
                        reason: TOO_LARGE.to_owned(),
                    }
                }
                // A request too large is answered in the call itself (`host`); nothing else is.
                FromWorker::Ready { .. } | FromWorker::Host { .. } => return,
            };
            if frame::write(&mut *out, &small).is_err() {
                std::process::exit(1);
            }
        }
        Err(_) => std::process::exit(1),
    }
}

/// Why a call's answer or request didn't cross the pipe.
pub const TOO_LARGE: &str = "it is larger than the 16 MiB the pipe to Spade carries";

impl Worker {
    fn send(&self, message: &FromWorker) {
        send(&self.out, message);
    }

    fn handle(&self, message: ToWorker) {
        match message {
            ToWorker::Load { component, path } => self.load(component, &path),
            ToWorker::Call {
                id,
                component,
                target,
                input,
                bounds,
            } => self.call(id, &component, target, input, bounds),
            ToWorker::Reply {
                id,
                request,
                answer,
            } => {
                if let Ok(open) = self.open.lock()
                    && let Some(call) = open.get(&id)
                {
                    let _ = call.events.send(CallEvent::Reply { request, answer });
                }
            }
            ToWorker::Stop { id } => {
                let Ok(open) = self.open.lock() else {
                    return;
                };
                for (_, call) in open.iter().filter(|(k, _)| id.is_none_or(|id| **k == id)) {
                    call.stop.store(true, Ordering::SeqCst);
                    let _ = call.events.send(CallEvent::Stop);
                }
            }
        }
    }

    /// Compiles on a thread of its own, so Stop is read while it compiles.
    fn load(&self, component: String, path: &Path) {
        let engine = self.engine.clone();
        let linker = Arc::clone(&self.linker);
        let loaded = Arc::clone(&self.loaded);
        let out = Arc::clone(&self.out);
        let path = path.to_owned();
        std::thread::spawn(move || {
            // Nothing is compiled outside the sandbox Spade set up.
            let compiled = crate::confine::confined()
                .and_then(|()| compile(&engine, &linker, &component, &path));
            let message = match compiled {
                Ok(ready) => {
                    if let Ok(mut loaded) = loaded.lock() {
                        loaded.insert(component.clone(), Arc::new(ready));
                    }
                    FromWorker::Loaded { component }
                }
                Err(reason) => FromWorker::LoadFailed { component, reason },
            };
            send(&out, &message);
        });
    }

    fn call(&self, id: u64, component: &str, target: Target, input: String, bounds: code::Bounds) {
        let refused = |message: String| FromWorker::Failed {
            id,
            cut: Cut::Refused,
            message,
            stats: Stats::default(),
            logs: Vec::new(),
        };
        let Some(loaded) = self
            .loaded
            .lock()
            .ok()
            .and_then(|loaded| loaded.get(component).cloned())
        else {
            return self.send(&refused(format!("{component} isn't loaded")));
        };
        let (events, receiver) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        {
            let Ok(mut open) = self.open.lock() else {
                return;
            };
            if open.len() >= MOST_CALLS {
                drop(open);
                return self.send(&refused(format!(
                    "{MOST_CALLS} code calls already run for this bot"
                )));
            }
            open.insert(
                id,
                Open {
                    events,
                    stop: Arc::clone(&stop),
                },
            );
        }
        let state = CallState::new(
            id,
            stop,
            Duration::from_millis(bounds.deadline_ms),
            bounds.memory_bytes,
            Arc::clone(&self.out),
            receiver,
            self.base,
        );
        let engine = self.engine.clone();
        let out = Arc::clone(&self.out);
        let open = Arc::clone(&self.open);
        std::thread::spawn(move || {
            let answer = run(&engine, &loaded, state, &target, &input, bounds.fuel, id);
            // Taken out first, so a late Stop or reply finds nothing.
            if let Ok(mut open) = open.lock() {
                open.remove(&id);
            }
            send(&out, &answer);
        });
    }
}

/// The component at `path`, checked against Spade's world and its hash, compiled and linked.
fn compile(
    engine: &Engine,
    linker: &Linker<CallState>,
    component: &str,
    path: &Path,
) -> Result<Loaded, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("its bytes couldn't be read: {e}"))?;
    let hash: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if hash != component {
        return Err("its bytes don't hash to the component Spade named".to_owned());
    }
    // The second wall's first check: nothing outside Spade's world is compiled here either.
    let inspected = code::inspect(&path.to_string_lossy(), &bytes)
        .map_err(|found| spade_core::rule::joined(&found, "; "))?;
    if !inspected.exports.iter().any(|e| e == code::TOOLBOX) {
        return Err(format!("it doesn't export {}", code::TOOLBOX));
    }
    let compiled = Component::new(engine, &bytes).map_err(|e| format!("it didn't compile: {e}"))?;
    let toolbox = compiled
        .component_type()
        .exports(engine)
        .map(|(name, _)| name.to_owned())
        .find(|name| name.starts_with("spade:package/toolbox@1.0."))
        .ok_or_else(|| format!("it doesn't export {}", code::TOOLBOX))?;
    let pre = linker
        .instantiate_pre(&compiled)
        .map_err(|e| format!("it doesn't link to Spade's world: {e}"))?;
    Ok(Loaded { pre, toolbox })
}

/// One call, from a fresh store to its answer.
fn run(
    engine: &Engine,
    loaded: &Loaded,
    state: CallState,
    target: &Target,
    input: &str,
    fuel: u64,
    id: u64,
) -> FromWorker {
    let mut store = Store::new(engine, state);
    store.limiter(|state| &mut state.limiter);
    let answer = (|| -> wasmtime::Result<Result<String, String>> {
        store.set_fuel(fuel)?;
        store.set_epoch_deadline(1);
        store.epoch_deadline_callback(|cx| {
            let state = cx.data();
            match over(&state.stop, &state.clock, state.deadline) {
                Some(cut) => Err(wasmtime::Error::new(Cutting(cut))),
                None => Ok(UpdateDeadline::Continue(1)),
            }
        });
        let instance = loaded.pre.instantiate(&mut store)?;
        let toolbox = instance
            .get_export_index(&mut store, None, &loaded.toolbox)
            .ok_or_else(|| wasmtime::Error::msg("its toolbox is missing"))?;
        match target {
            Target::Tools => {
                let index = instance
                    .get_export_index(&mut store, Some(&toolbox), "tools")
                    .ok_or_else(|| wasmtime::Error::msg("its toolbox has no tools function"))?;
                let tools = instance.get_typed_func::<(), (String,)>(&mut store, &index)?;
                let (json,) = tools.call(&mut store, ())?;
                Ok(Ok(json))
            }
            Target::Tool { name } => {
                let index = instance
                    .get_export_index(&mut store, Some(&toolbox), "call")
                    .ok_or_else(|| wasmtime::Error::msg("its toolbox has no call function"))?;
                let call = instance.get_typed_func::<(&str, &str), (Result<String, String>,)>(
                    &mut store, &index,
                )?;
                let (output,) = call.call(&mut store, (name.as_str(), input))?;
                Ok(output)
            }
        }
    })();
    let used = fuel.saturating_sub(store.get_fuel().unwrap_or(0));
    let state = store.into_data();
    let stats = Stats {
        run_ms: u64::try_from(state.clock.spent().as_millis()).unwrap_or(u64::MAX),
        fuel: used,
        peak_memory: state.limiter.peak as u64,
    };
    match answer {
        Ok(output) => FromWorker::Done {
            id,
            output,
            stats,
            logs: state.logs,
        },
        Err(error) => {
            let cut = cut_of(&error);
            FromWorker::Failed {
                id,
                cut,
                message: message(cut, &error, &state),
                stats,
                logs: state.logs,
            }
        }
    }
}

/// What a call that gave no answer says, in a line (ADR 0203 §4).
fn message(cut: Cut, error: &wasmtime::Error, state: &CallState) -> String {
    match cut {
        Cut::Deadline => format!(
            "it ran longer than {} s",
            state.deadline.as_secs_f64().ceil() as u64
        ),
        Cut::Fuel => "it ran a loop that never yields, past its fuel".to_owned(),
        Cut::Memory => format!(
            "it grew its memory past {} MiB",
            state.limiter.bound() / (1024 * 1024)
        ),
        Cut::Stopped => "it was stopped".to_owned(),
        Cut::Trap | Cut::Refused | Cut::Lost => {
            let text = error.to_string();
            format!(
                "it trapped: {}",
                text.lines().next().unwrap_or("no reason given")
            )
        }
    }
}
