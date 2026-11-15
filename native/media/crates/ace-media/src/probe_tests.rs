// SPDX-License-Identifier: Apache-2.0
use super::*;

struct Scripted {
    delay: Duration,
    state: TrialState,
}

impl Trial for Scripted {
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
        vec![(Step::Encode, Some("avc1.640028".into()), Backend::Vt)]
    }
    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>), _stop: &dyn Fn() -> bool) {
        std::thread::sleep(self.delay);
        publish(entries(&self.steps(), self.state));
    }
}

fn scripted(ms: u64, state: TrialState) -> Box<dyn Trial> {
    Box::new(Scripted {
        delay: Duration::from_millis(ms),
        state,
    })
}

#[test]
fn the_cpu_path_is_reported_available_without_claiming_hardware() {
    let (capabilities, _) = probe(vec![Box::new(CpuTrial)], TRIAL_DEADLINE, &Cancel::default());
    let list = capabilities.list();
    assert_eq!(list.len(), 3);
    for entry in list {
        assert_eq!(entry.state, TrialState::Ok);
        assert_eq!(entry.backend, Backend::Cpu);
        assert!(!entry.hardware && !entry.zero_copy);
        assert!(entry.max_width > 0);
        assert_eq!(entry.codec.is_none(), entry.step == Step::Scale);
    }
}

#[test]
fn a_hung_trial_is_timed_out_at_the_deadline_and_its_late_result_replaces_it() {
    let started = Instant::now();
    let (mut capabilities, late) = probe(
        vec![
            scripted(0, TrialState::Failed),
            scripted(300, TrialState::Ok),
        ],
        Duration::from_millis(100),
        &Cancel::default(),
    );
    assert!(started.elapsed() < Duration::from_millis(280));
    let states: Vec<_> = capabilities.list().iter().map(|c| c.state).collect();
    assert_eq!(states, [TrialState::Failed, TrialState::TimedOut]);
    let Ok((trial, found)) = late.recv_timeout(Duration::from_secs(2)) else {
        panic!("no late result");
    };
    capabilities.update(trial, found);
    let states: Vec<_> = capabilities.list().iter().map(|c| c.state).collect();
    assert_eq!(states, [TrialState::Failed, TrialState::Ok]);
}

/// Publishes a first answer at once, then more after `later`, then keeps running.
struct Staged {
    later: Duration,
    release: mpsc::Receiver<()>,
}

impl Trial for Staged {
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
        vec![(Step::Decode, Some("hvc1".into()), Backend::Vt)]
    }
    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>), _stop: &dyn Fn() -> bool) {
        publish(entries(&self.steps(), TrialState::TimedOut));
        std::thread::sleep(self.later);
        publish(entries(&self.steps(), TrialState::Ok));
        // Still running: the update must not wait for the trial to end.
        let _ = self.release.recv_timeout(Duration::from_secs(5));
    }
}

#[test]
fn what_a_trial_publishes_after_the_deadline_arrives_while_it_is_still_running() {
    let (release, wait) = mpsc::channel();
    let staged = Staged {
        later: Duration::from_millis(150),
        release: wait,
    };
    let (mut capabilities, late) = probe(
        vec![Box::new(staged)],
        Duration::from_millis(50),
        &Cancel::default(),
    );
    let states: Vec<_> = capabilities.list().iter().map(|c| c.state).collect();
    assert_eq!(
        states,
        [TrialState::TimedOut],
        "the first answer is in ready"
    );
    let Ok((trial, found)) = late.recv_timeout(Duration::from_secs(2)) else {
        panic!("the later answer did not arrive while the trial ran");
    };
    capabilities.update(trial, found);
    let states: Vec<_> = capabilities.list().iter().map(|c| c.state).collect();
    assert_eq!(states, [TrialState::Ok]);
    let _ = release.send(());
}

/// Lists a codec on hardware, but its trial frame failed.
struct ListsButFails;

impl Trial for ListsButFails {
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
        vec![(Step::Encode, Some("avc1.640028".into()), Backend::Vaapi)]
    }
    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>), _stop: &dyn Fn() -> bool) {
        publish(vec![Capability {
            step: Step::Encode,
            codec: Some("avc1.640028".into()),
            backend: Backend::Vaapi,
            hardware: true,
            zero_copy: true,
            state: TrialState::Failed,
            max_width: 4096,
            max_height: 4096,
        }]);
    }
}

#[test]
fn a_backend_that_lists_a_codec_but_fails_its_trial_frame_counts_as_no_hardware() {
    let (capabilities, _) = probe(
        vec![Box::new(ListsButFails)],
        TRIAL_DEADLINE,
        &Cancel::default(),
    );
    let list = capabilities.list();
    assert_eq!(list.len(), 1);
    let entry = &list[0];
    assert_eq!(entry.state, TrialState::Failed);
    assert!(!entry.hardware && !entry.zero_copy);
    assert_eq!((entry.max_width, entry.max_height), (0, 0));
    assert_eq!(
        crate::encode::select::encoder_for(&list, media_codec::Codec::H264, &[Backend::Vaapi]),
        None
    );
}

/// Never publishes until told to stop, then says whether it saw the stop.
struct Hung {
    stopped: mpsc::Sender<()>,
}

impl Trial for Hung {
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
        vec![(Step::Encode, Some("hvc1.1.6.L120.B0".into()), Backend::Nv)]
    }
    fn run(self: Box<Self>, _publish: &mut dyn FnMut(Vec<Capability>), stop: &dyn Fn() -> bool) {
        while !stop() {
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.stopped.send(());
    }
}

#[test]
fn a_hung_trial_is_timed_out_within_two_seconds_and_ready_comes_within_three() {
    let (stopped, saw_stop) = mpsc::channel();
    let cancel = Cancel::default();
    let started = Instant::now();
    let (capabilities, _) = probe(
        vec![Box::new(Hung { stopped }), Box::new(CpuTrial)],
        TRIAL_DEADLINE,
        &cancel,
    );
    let took = started.elapsed();
    assert!(took >= TRIAL_DEADLINE && took < READY_DEADLINE, "{took:?}");
    let list = capabilities.list();
    assert_eq!(list[0].state, TrialState::TimedOut);
    assert!(list[1..].iter().all(|c| c.state == TrialState::Ok));
    // An abandoned trial keeps running until ace-media stops it, then closes what it opened.
    assert!(saw_stop.recv_timeout(Duration::from_millis(100)).is_err());
    cancel.cancel();
    assert!(saw_stop.recv_timeout(Duration::from_secs(1)).is_ok());
}

#[test]
fn the_probe_returns_as_soon_as_every_trial_has_finished() {
    let started = Instant::now();
    let (capabilities, _) = probe(
        vec![Box::new(CpuTrial), scripted(20, TrialState::Ok)],
        TRIAL_DEADLINE,
        &Cancel::default(),
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(capabilities.list().len(), 4);
}
