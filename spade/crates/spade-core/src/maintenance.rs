//! Closing Spade for an update or a stop (docs/ace-integration.md, "Updates" and "Stop"): when
//! open turns pause, and which work each kind of close waits for. The engine applies these.

use std::time::Duration;

/// How long `now` lets a running model step finish before cutting it.
pub const NOW_STEP_ALLOWANCE: Duration = Duration::from_secs(30);

/// How long a plain stop (SIGTERM) lets a running model step finish.
pub const STOP_STEP_ALLOWANCE: Duration = Duration::from_secs(5);

/// How long admission stays closed after every turn paused, if no restart comes. An updater that
/// died mid-swap must not leave Spade refusing to start turns forever.
pub const HOLD_AFTER_PAUSE: Duration = Duration::from_secs(5 * 60);

/// What an update waits for before it pauses open turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Wait until no turn is working and no background job runs.
    Idle,
    /// Wait only for running model steps.
    Now,
}

impl Mode {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "idle" => Some(Self::Idle),
            "now" => Some(Self::Now),
            _ => None,
        }
    }
}

/// What a turn's worker is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Pause {
    #[default]
    Off,
    /// Pause at the next point where nothing of the turn runs; a model step already streaming
    /// finishes first.
    AfterStep,
    /// Pause now, cutting a streaming step (its text is asked for again on resume).
    Now,
}

/// Where a turn's worker is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Point {
    /// About to call the model or run tools: nothing is in flight.
    Between,
    /// A model step is streaming.
    Streaming,
    /// Tools are running. They are cut, and each call says it may have run.
    RunningTools,
    /// Waiting for the person to answer an approval.
    WaitingOnYou,
}

/// Whether a worker at `point` pauses now.
pub fn halts(pause: Pause, point: Point) -> bool {
    match pause {
        Pause::Off => false,
        Pause::AfterStep => point != Point::Streaming,
        Pause::Now => true,
    }
}

/// What is still going on while an update waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Load {
    /// Turns working: streaming, running tools or about to (not those waiting on the person).
    pub working_turns: usize,
    pub running_jobs: usize,
}

/// Whether an update in `mode` can tell open turns to pause now.
pub fn ready(mode: Mode, load: Load) -> bool {
    match mode {
        Mode::Idle => load.working_turns == 0 && load.running_jobs == 0,
        Mode::Now => true,
    }
}

/// How long a streaming step may finish before it is cut, for `now` with the updater's deadline.
pub fn step_allowance(deadline: Option<Duration>) -> Duration {
    deadline.map_or(NOW_STEP_ALLOWANCE, |d| d.min(NOW_STEP_ALLOWANCE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_waits_for_working_turns_and_jobs_and_now_does_not() {
        let busy = Load {
            working_turns: 1,
            running_jobs: 0,
        };
        let job = Load {
            working_turns: 0,
            running_jobs: 2,
        };
        assert!(!ready(Mode::Idle, busy));
        assert!(!ready(Mode::Idle, job));
        assert!(ready(Mode::Idle, Load::default()));
        assert!(ready(Mode::Now, busy) && ready(Mode::Now, job));
    }

    #[test]
    fn a_streaming_step_finishes_unless_the_pause_is_immediate() {
        assert!(!halts(Pause::AfterStep, Point::Streaming));
        for point in [Point::Between, Point::RunningTools, Point::WaitingOnYou] {
            assert!(halts(Pause::AfterStep, point), "{point:?}");
        }
        assert!(halts(Pause::Now, Point::Streaming));
        assert!(!halts(Pause::Off, Point::Between));
    }

    #[test]
    fn a_step_gets_at_most_thirty_seconds_and_less_if_the_updater_asks() {
        assert_eq!(step_allowance(None), Duration::from_secs(30));
        assert_eq!(
            step_allowance(Some(Duration::from_secs(90))),
            Duration::from_secs(30)
        );
        assert_eq!(
            step_allowance(Some(Duration::from_millis(200))),
            Duration::from_millis(200)
        );
    }

    #[test]
    fn modes_parse_from_their_wire_names_only() {
        assert_eq!(Mode::parse("idle"), Some(Mode::Idle));
        assert_eq!(Mode::parse("now"), Some(Mode::Now));
        assert_eq!(Mode::parse("Now"), None);
    }
}
