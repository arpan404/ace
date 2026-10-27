//! When an app has settled after an action, and when the person is using it. Pure rules over
//! durations, so they are tested without clocks.
use std::time::Duration;

#[derive(Clone, Copy, Debug)]
pub struct SettleRule {
    /// Quiet this long after the app's last event once it has reacted.
    pub quiet: Duration,
    /// How long to wait when the app sends no event at all.
    pub unreacted: Duration,
    /// Never longer than this.
    pub max: Duration,
}

/// Between steps of a batch.
pub const BETWEEN_STEPS: SettleRule = SettleRule {
    quiet: Duration::from_millis(40),
    unreacted: Duration::from_millis(100),
    max: Duration::from_millis(1200),
};

/// Before the look that ends a batch.
pub const BEFORE_LOOK: SettleRule = SettleRule {
    quiet: Duration::from_millis(60),
    unreacted: Duration::from_millis(150),
    max: Duration::from_millis(2000),
};

/// After launching an app, before its first look.
pub const AFTER_LAUNCH: SettleRule = SettleRule {
    quiet: Duration::from_millis(300),
    unreacted: Duration::from_millis(200),
    max: Duration::from_millis(2000),
};

/// Whether waiting can end: `elapsed` since the action, `since_event` since the app's last
/// event (None when it sent none).
pub fn settled(rule: &SettleRule, elapsed: Duration, since_event: Option<Duration>) -> bool {
    if elapsed >= rule.max {
        return true;
    }
    match since_event {
        Some(quiet) => quiet >= rule.quiet,
        None => elapsed >= rule.unreacted,
    }
}

/// How recent the person's own input must be for their use of the app to come first.
pub const PERSON_WINDOW: Duration = Duration::from_millis(1500);

/// The person is using the app: it is in front and they gave real input moments ago.
pub fn person_active(app_in_front: bool, since_person_input: Option<Duration>) -> bool {
    app_in_front && since_person_input.is_some_and(|age| age < PERSON_WINDOW)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn an_app_that_reacted_settles_once_it_goes_quiet() {
        assert!(!settled(&BEFORE_LOOK, ms(80), Some(ms(10))));
        assert!(settled(&BEFORE_LOOK, ms(80), Some(ms(60))));
    }

    #[test]
    fn a_silent_app_gets_the_unreacted_interval_and_a_busy_one_the_cap() {
        assert!(!settled(&BEFORE_LOOK, ms(100), None));
        assert!(settled(&BEFORE_LOOK, ms(150), None));
        assert!(settled(&BEFORE_LOOK, ms(2000), Some(ms(1))));
    }

    #[test]
    fn the_person_comes_first_only_in_the_app_in_front() {
        assert!(person_active(true, Some(ms(300))));
        assert!(!person_active(true, Some(ms(3000))));
        assert!(!person_active(false, Some(ms(10))));
        assert!(!person_active(true, None));
    }
}
