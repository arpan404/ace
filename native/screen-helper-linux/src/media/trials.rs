//! The capture → encode trials the hello reports (K2), run once at helper start on a thread of
//! their own: VA-API's and NVENC's (each behind its gate), then the last-resort encoder's only
//! when neither worked. The hello waits for them at most [`HELLO_WAIT`].
use super::select::{Trials, VAAPI_OPT_IN, last_resort_needed};
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, atomic::AtomicBool},
    time::{Duration, Instant},
};

/// Longest the hello waits for the trials, from helper start.
pub const HELLO_WAIT: Duration = Duration::from_secs(5);
/// The last-resort trial's own deadline: a cold Chrome start and one picture.
const CHROME_DEADLINE: Duration = Duration::from_secs(4);

/// Where the last-resort encoder's Chrome is found and its profiles made.
#[derive(Clone, Debug)]
pub struct ChromePlace {
    pub data_dir: Option<PathBuf>,
    pub profile_root: PathBuf,
}

impl ChromePlace {
    pub fn options(&self) -> Option<media_chrome::ChromeOptions> {
        let search = media_chrome::ChromeSearch::from_env(self.data_dir.clone());
        let executable = media_chrome::find_chrome(&search)?;
        Some(media_chrome::ChromeOptions::new(
            executable,
            self.profile_root.clone(),
        ))
    }
}

#[derive(Default)]
struct Slot {
    trials: Option<Trials>,
}

/// The trials' results, once they are in.
#[derive(Clone)]
pub struct Found {
    slot: Arc<(Mutex<Slot>, Condvar)>,
    started: Instant,
    pub chrome: ChromePlace,
}

impl Found {
    /// Starts the trials.
    pub fn start(chrome: ChromePlace) -> Self {
        let found = Self {
            slot: Arc::default(),
            started: Instant::now(),
            chrome,
        };
        let worker = found.clone();
        let _ = std::thread::Builder::new()
            .name("encode-trials".into())
            .spawn(move || {
                let trials = run(&worker.chrome);
                let (lock, ready) = &*worker.slot;
                if let Ok(mut slot) = lock.lock() {
                    slot.trials = Some(trials);
                }
                ready.notify_all();
            });
        found
    }

    /// The results, waiting until [`HELLO_WAIT`] after start; `None` if they are still running.
    pub fn wait(&self) -> Option<Trials> {
        let (lock, ready) = &*self.slot;
        let left = HELLO_WAIT.saturating_sub(self.started.elapsed());
        let slot = lock.lock().ok()?;
        let (slot, _) = ready
            .wait_timeout_while(slot, left, |s| s.trials.is_none())
            .ok()?;
        slot.trials.clone()
    }
}

fn run(chrome: &ChromePlace) -> Trials {
    let stop = || false;
    let opted_in = std::env::var_os(VAAPI_OPT_IN).is_some_and(|v| v == "1");
    let vaapi = opted_in
        .then(|| {
            media_vaapi::run_trial(&stop).into_iter().find(|c| {
                c.step == Step::Encode && c.codec.as_deref().is_some_and(|s| s.starts_with("avc1"))
            })
        })
        .flatten();
    let nv = nv_trial(&stop);
    let mut trials = Trials {
        vaapi,
        nv,
        chrome: None,
    };
    if last_resort_needed(&trials) {
        trials.chrome = chrome.options().map(|options| {
            media_chrome::probe(options, CHROME_DEADLINE, Arc::new(AtomicBool::new(false)))
        });
    }
    trials
}

fn nv_trial(stop: &dyn Fn() -> bool) -> Option<Capability> {
    let media_nv::NvProbe::Present(entries) = media_nv::probe(stop) else {
        return None;
    };
    let entry = entries
        .into_iter()
        .find(|e| e.step == media_nv::ProbeStep::Encode && e.codec == media_codec::Codec::H264)?;
    let (state, max) = match entry.outcome {
        media_nv::ProbeOutcome::Ok { max } => (TrialState::Ok, max),
        media_nv::ProbeOutcome::Cancelled => (TrialState::TimedOut, NO_SIZE),
        media_nv::ProbeOutcome::Failed(_) => (TrialState::Failed, NO_SIZE),
    };
    let ok = state == TrialState::Ok;
    Some(Capability {
        step: Step::Encode,
        codec: Some("avc1.640028".into()),
        backend: Backend::Nv,
        hardware: ok,
        // DMA-BUF → EGLImage → GL texture, registered with NVENC.
        zero_copy: ok,
        state,
        max_width: max.width,
        max_height: max.height,
    })
}

const NO_SIZE: media_codec::Size = media_codec::Size {
    width: 0,
    height: 0,
};
