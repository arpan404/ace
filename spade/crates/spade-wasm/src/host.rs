//! The imports a component may have (ADR 0203 §2), defined for the worker's linker. The worker
//! holds no authority: `tools`, `http` and `kv` are asked of Spade over the pipe, which decides
//! after its gate, and the call's clock is paused while it waits. `log` is kept with the call; the
//! clocks, `wasi:io/poll` (for the monotonic clock) and `random` answer here. Nothing else is
//! defined, so a component importing anything else doesn't link.

use std::io::Write;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use wasmtime::StoreContextMut;
use wasmtime::component::{
    ComponentType, Lift, Linker, Lower, Resource, ResourceTable, ResourceType,
};

use crate::engine::{Clock, Cutting, Limiter, TICK, over};
use crate::frame;
use crate::protocol::{Answer, Cut, FromWorker, HostRequest, HostValue};

/// A call's logs: at most this many bytes in all (ADR 0203 §2).
pub const MOST_LOG_BYTES: usize = 64 * 1024;

/// The pipe to Spade, shared by every call's thread.
pub type Out = Arc<Mutex<Box<dyn Write + Send>>>;

/// What reaches a running call from Spade.
#[derive(Debug)]
pub enum CallEvent {
    Reply { request: u64, answer: Answer },
    Stop,
}

/// One call's store data.
pub struct CallState {
    pub id: u64,
    pub stop: Arc<AtomicBool>,
    pub clock: Clock,
    pub deadline: Duration,
    pub limiter: Limiter,
    pub logs: Vec<String>,
    log_bytes: usize,
    table: ResourceTable,
    out: Out,
    events: Receiver<CallEvent>,
    next_request: u64,
    /// The monotonic clock's zero.
    base: Instant,
}

impl CallState {
    pub fn new(
        id: u64,
        stop: Arc<AtomicBool>,
        deadline: Duration,
        memory_bytes: u64,
        out: Out,
        events: Receiver<CallEvent>,
        base: Instant,
    ) -> Self {
        Self {
            id,
            stop,
            clock: Clock::running(),
            deadline,
            limiter: Limiter::new(memory_bytes),
            logs: Vec::new(),
            log_bytes: 0,
            table: ResourceTable::new(),
            out,
            events,
            next_request: 0,
            base,
        }
    }

    /// Asks Spade for `call` and waits for its answer, with the clock paused. Stop while waiting
    /// ends the call.
    fn ask(&mut self, call: HostRequest) -> wasmtime::Result<Answer> {
        self.next_request += 1;
        let request = self.next_request;
        let message = FromWorker::Host {
            id: self.id,
            request,
            call,
        };
        {
            let mut out = self
                .out
                .lock()
                .map_err(|_| wasmtime::Error::msg("the pipe to Spade is gone"))?;
            frame::write(&mut *out, &message)?;
        }
        self.clock.pause();
        let answer = loop {
            match self.events.recv() {
                Ok(CallEvent::Reply { request: r, answer }) if r == request => break answer,
                Ok(CallEvent::Reply { .. }) => {}
                Ok(CallEvent::Stop) | Err(_) => {
                    return Err(wasmtime::Error::new(Cutting(Cut::Stopped)));
                }
            }
        };
        self.clock.resume();
        Ok(answer)
    }

    /// Waits until `until` as the component asked, running time; Stop and the deadline end it.
    fn sleep(&mut self, until: Instant) -> wasmtime::Result<()> {
        loop {
            if let Some(cut) = over(&self.stop, &self.clock, self.deadline) {
                return Err(wasmtime::Error::new(Cutting(cut)));
            }
            let now = Instant::now();
            if now >= until {
                return Ok(());
            }
            match self.events.recv_timeout((until - now).min(TICK)) {
                Ok(CallEvent::Stop) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(wasmtime::Error::new(Cutting(Cut::Stopped)));
                }
                Ok(CallEvent::Reply { .. }) | Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn log(&mut self, level: Level, line: String) {
        let line = format!("{}: {line}", level.word());
        if self.log_bytes + line.len() > MOST_LOG_BYTES {
            return;
        }
        self.log_bytes += line.len();
        self.logs.push(line);
    }

    fn monotonic(&self) -> u64 {
        u64::try_from(self.base.elapsed().as_nanos()).unwrap_or(u64::MAX)
    }
}

#[derive(ComponentType, Lift, Lower, Clone, Copy, Debug)]
#[component(enum)]
#[repr(u8)]
#[allow(
    dead_code,
    reason = "each level is built by lifting the component's value"
)]
enum Level {
    #[component(name = "debug")]
    Debug,
    #[component(name = "info")]
    Info,
    #[component(name = "warn")]
    Warn,
    #[component(name = "error")]
    Error,
}

impl Level {
    fn word(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(ComponentType, Lift, Lower, Clone, Debug)]
#[component(record)]
struct Header {
    name: String,
    value: String,
}

#[derive(ComponentType, Lift, Lower, Clone, Debug)]
#[component(record)]
struct Request {
    method: String,
    url: String,
    headers: Vec<Header>,
    body: Vec<u8>,
}

#[derive(ComponentType, Lift, Lower, Clone, Debug)]
#[component(record)]
struct Response {
    status: u16,
    headers: Vec<Header>,
    body: Vec<u8>,
}

#[derive(ComponentType, Lift, Lower, Clone, Copy, Debug)]
#[component(record)]
struct Datetime {
    seconds: u64,
    nanoseconds: u32,
}

/// The monotonic clock's `pollable`: ready at a point of the clock.
struct Pollable {
    at: u64,
}

type Cx<'a> = StoreContextMut<'a, CallState>;

/// A request whose answer isn't of the kind asked for: Spade's mistake, told to the component.
fn mismatched<T>() -> Result<T, String> {
    Err("Spade answered with something else".to_owned())
}

/// Every import Spade's world offers, versioned; a component importing a later patch of the same
/// minor version links to these.
pub fn link(linker: &mut Linker<CallState>) -> wasmtime::Result<()> {
    let mut tools = linker.instance("spade:package/tools@1.0.0")?;
    tools.func_wrap(
        "call",
        |mut cx: Cx<'_>,
         (name, input): (String, String)|
         -> wasmtime::Result<(Result<String, String>,)> {
            let answer = cx.data_mut().ask(HostRequest::Tools { name, input })?;
            Ok((match answer {
                Ok(HostValue::Json { json }) => Ok(json),
                Ok(_) => mismatched(),
                Err(why) => Err(why),
            },))
        },
    )?;

    let mut http = linker.instance("spade:package/http@1.0.0")?;
    http.func_wrap(
        "send",
        |mut cx: Cx<'_>, (req,): (Request,)| -> wasmtime::Result<(Result<Response, String>,)> {
            let call = HostRequest::Http {
                method: req.method,
                url: req.url,
                headers: req.headers.into_iter().map(|h| (h.name, h.value)).collect(),
                body: req.body,
            };
            Ok((match cx.data_mut().ask(call)? {
                Ok(HostValue::Response {
                    status,
                    headers,
                    body,
                }) => Ok(Response {
                    status,
                    headers: headers
                        .into_iter()
                        .map(|(name, value)| Header { name, value })
                        .collect(),
                    body,
                }),
                Ok(_) => mismatched(),
                Err(why) => Err(why),
            },))
        },
    )?;

    let mut log = linker.instance("spade:package/log@1.0.0")?;
    log.func_wrap(
        "write",
        |mut cx: Cx<'_>, (level, line): (Level, String)| -> wasmtime::Result<()> {
            cx.data_mut().log(level, line);
            Ok(())
        },
    )?;

    link_kv(linker)?;
    link_clocks(linker)?;

    let mut random = linker.instance("wasi:random/random@0.2.0")?;
    random.func_wrap(
        "get-random-bytes",
        |_cx: Cx<'_>, (len,): (u64,)| -> wasmtime::Result<(Vec<u8>,)> {
            // A call's memory bounds what it can take; this bounds one request.
            let len = usize::try_from(len.min(1024 * 1024)).unwrap_or(0);
            let mut bytes = vec![0u8; len];
            getrandom::fill(&mut bytes).map_err(|e| wasmtime::Error::msg(e.to_string()))?;
            Ok((bytes,))
        },
    )?;
    random.func_wrap(
        "get-random-u64",
        |_cx: Cx<'_>, (): ()| -> wasmtime::Result<(u64,)> {
            Ok((getrandom::u64().map_err(|e| wasmtime::Error::msg(e.to_string()))?,))
        },
    )?;
    Ok(())
}

fn link_kv(linker: &mut Linker<CallState>) -> wasmtime::Result<()> {
    let mut kv = linker.instance("spade:package/kv@1.0.0")?;
    kv.func_wrap(
        "get",
        |mut cx: Cx<'_>,
         (key,): (String,)|
         -> wasmtime::Result<(Result<Option<Vec<u8>>, String>,)> {
            Ok((match cx.data_mut().ask(HostRequest::KvGet { key })? {
                Ok(HostValue::Value { value }) => Ok(value),
                Ok(_) => mismatched(),
                Err(why) => Err(why),
            },))
        },
    )?;
    kv.func_wrap(
        "set",
        |mut cx: Cx<'_>,
         (key, value): (String, Vec<u8>)|
         -> wasmtime::Result<(Result<(), String>,)> {
            Ok((done(cx.data_mut().ask(HostRequest::KvSet { key, value })?),))
        },
    )?;
    kv.func_wrap(
        "delete",
        |mut cx: Cx<'_>, (key,): (String,)| -> wasmtime::Result<(Result<(), String>,)> {
            Ok((done(cx.data_mut().ask(HostRequest::KvDelete { key })?),))
        },
    )?;
    kv.func_wrap(
        "keys",
        |mut cx: Cx<'_>,
         (prefix,): (String,)|
         -> wasmtime::Result<(Result<Vec<String>, String>,)> {
            Ok((match cx.data_mut().ask(HostRequest::KvKeys { prefix })? {
                Ok(HostValue::Keys { keys }) => Ok(keys),
                Ok(_) => mismatched(),
                Err(why) => Err(why),
            },))
        },
    )?;
    Ok(())
}

fn done(answer: Answer) -> Result<(), String> {
    match answer {
        Ok(HostValue::Done) => Ok(()),
        Ok(_) => mismatched(),
        Err(why) => Err(why),
    }
}

fn link_clocks(linker: &mut Linker<CallState>) -> wasmtime::Result<()> {
    let mut wall = linker.instance("wasi:clocks/wall-clock@0.2.0")?;
    wall.func_wrap(
        "now",
        |_cx: Cx<'_>, (): ()| -> wasmtime::Result<(Datetime,)> {
            let since = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default();
            Ok((Datetime {
                seconds: since.as_secs(),
                nanoseconds: since.subsec_nanos(),
            },))
        },
    )?;
    wall.func_wrap(
        "resolution",
        |_cx: Cx<'_>, (): ()| -> wasmtime::Result<(Datetime,)> {
            Ok((Datetime {
                seconds: 0,
                nanoseconds: 1000,
            },))
        },
    )?;

    let mut poll = linker.instance("wasi:io/poll@0.2.0")?;
    poll.resource(
        "pollable",
        ResourceType::host::<Pollable>(),
        |mut cx: Cx<'_>, rep: u32| -> wasmtime::Result<()> {
            cx.data_mut()
                .table
                .delete(Resource::<Pollable>::new_own(rep))?;
            Ok(())
        },
    )?;
    poll.func_wrap(
        "[method]pollable.ready",
        |cx: Cx<'_>, (this,): (Resource<Pollable>,)| -> wasmtime::Result<(bool,)> {
            let at = cx.data().table.get(&this)?.at;
            Ok((cx.data().monotonic() >= at,))
        },
    )?;
    poll.func_wrap(
        "[method]pollable.block",
        |mut cx: Cx<'_>, (this,): (Resource<Pollable>,)| -> wasmtime::Result<()> {
            let state = cx.data_mut();
            let at = state.table.get(&this)?.at;
            let until = state.base + Duration::from_nanos(at);
            state.sleep(until)
        },
    )?;
    poll.func_wrap(
        "poll",
        |mut cx: Cx<'_>, (all,): (Vec<Resource<Pollable>>,)| -> wasmtime::Result<(Vec<u32>,)> {
            let state = cx.data_mut();
            let mut times = Vec::with_capacity(all.len());
            for one in &all {
                times.push(state.table.get(one)?.at);
            }
            let Some(first) = times.iter().copied().min() else {
                return Ok((Vec::new(),));
            };
            state.sleep(state.base + Duration::from_nanos(first))?;
            let now = state.monotonic();
            let ready = (0u32..)
                .zip(&times)
                .filter(|(_, at)| now >= **at)
                .map(|(i, _)| i)
                .collect();
            Ok((ready,))
        },
    )?;

    let mut mono = linker.instance("wasi:clocks/monotonic-clock@0.2.0")?;
    mono.func_wrap("now", |cx: Cx<'_>, (): ()| -> wasmtime::Result<(u64,)> {
        Ok((cx.data().monotonic(),))
    })?;
    mono.func_wrap(
        "resolution",
        |_cx: Cx<'_>, (): ()| -> wasmtime::Result<(u64,)> { Ok((1000,)) },
    )?;
    mono.func_wrap(
        "subscribe-instant",
        |mut cx: Cx<'_>, (at,): (u64,)| -> wasmtime::Result<(Resource<Pollable>,)> {
            Ok((cx.data_mut().table.push(Pollable { at })?,))
        },
    )?;
    mono.func_wrap(
        "subscribe-duration",
        |mut cx: Cx<'_>, (after,): (u64,)| -> wasmtime::Result<(Resource<Pollable>,)> {
            let state = cx.data_mut();
            let at = state.monotonic().saturating_add(after);
            Ok((state.table.push(Pollable { at })?,))
        },
    )?;
    Ok(())
}
