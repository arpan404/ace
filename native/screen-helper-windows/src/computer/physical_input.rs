//! Session-local physical input, sampled only when cowork needs a lease decision.
use super::desktop;

pub fn idle_ms() -> Option<u32> {
    desktop::watch_person();
    desktop::since_person_input().map(|age| age.as_millis().min(u128::from(u32::MAX)) as u32)
}
