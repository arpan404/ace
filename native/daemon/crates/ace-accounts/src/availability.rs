// SPDX-License-Identifier: Apache-2.0
//! What an account's quota means at a moment, from `packages/accounts/src/availability.ts`.
//! Pure and portable: the daemon decides with it and clients word the same facts with it, so
//! both always agree. Only a definite provider signal holds an account: a fresh live window at
//! 100% or the provider's own usage-limit code.

use crate::quota::{AccountQuota, QuotaWindow};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    Available,
    NearLimit,
    Exhausted,
    LoggedOut,
    Unknown,
}

/// From this share of a live window used, an account is near its limit.
pub const NEAR_LIMIT_PERCENT: f64 = 80.0;

/// A reading older than this is shown with its age and never holds an account at its limit.
pub const STALE_READING_MS: i64 = 30 * 60_000;

/// A window still in its period at `now`: one whose reset has passed no longer counts.
pub fn live_window(window: &QuotaWindow, now: i64) -> bool {
    window.resets_at.is_none_or(|resets_at| resets_at > now)
}

/// Whether a window was read recently enough at `now` to say anything about the account.
pub fn fresh_reading(window: &QuotaWindow, state: &AccountQuota, now: i64) -> bool {
    now - window.observed_at.unwrap_or(state.observed_at) <= STALE_READING_MS
}

/// The windows that say whether the account can work: a meter the provider shows never does.
fn limiting(state: &AccountQuota) -> impl Iterator<Item = &QuotaWindow> {
    state.windows.values().filter(|window| !window.advisory)
}

/// What the provider definitely said holds the account at `now`: full, live and fresh.
fn holding(state: &AccountQuota, now: i64) -> Vec<&QuotaWindow> {
    limiting(state)
        .chain(state.blockers.limit_error.iter())
        .filter(|window| {
            window.used_percent >= 100.0
                && live_window(window, now)
                && fresh_reading(window, state, now)
        })
        .collect()
}

/// Whether an account can take work at `now`.
pub fn availability(state: &AccountQuota, now: i64) -> Availability {
    if state.blockers.home_unavailable.is_some() {
        return Availability::Unknown;
    }
    if state.auth == crate::quota::AuthState::LoggedOut {
        return Availability::LoggedOut;
    }
    if state.auth != crate::quota::AuthState::LoggedIn {
        return Availability::Unknown;
    }
    if !holding(state, now).is_empty() {
        return Availability::Exhausted;
    }
    if limiting(state).any(|window| {
        window.used_percent >= NEAR_LIMIT_PERCENT
            && live_window(window, now)
            && fresh_reading(window, state, now)
    }) {
        return Availability::NearLimit;
    }
    Availability::Available
}

/// Whether the account has a fresh reading at `now` that shows it below its limit.
pub fn freshly_below_limit(state: &AccountQuota, now: i64) -> bool {
    let level = availability(state, now);
    (level == Availability::Available || level == Availability::NearLimit)
        && limiting(state)
            .any(|window| live_window(window, now) && fresh_reading(window, state, now))
}

/// When an account held at its limit can work again: the last reset among what holds it.
pub fn blocked_until(state: &AccountQuota, now: i64) -> Option<Option<i64>> {
    let holding = holding(state, now);
    if holding.is_empty() {
        return None;
    }
    let mut last: Option<i64> = None;
    for window in holding {
        if let Some(resets_at) = window.resets_at {
            last = Some(last.map_or(resets_at, |current| current.max(resets_at)));
        }
    }
    Some(last)
}

/// The parts of an `accounts.list` entry automatic recovery picks a target from.
pub trait TargetCandidate {
    fn id(&self) -> &str;
    fn provider(&self) -> crate::instance::Provider;
    fn quota(&self) -> &AccountQuota;
}

/// Where automatic recovery moves a thread off account `from`: the first other account of the
/// same provider, in listed order, that is available at `now`.
pub fn automatic_target<'a, T: TargetCandidate>(
    accounts: &'a [T],
    from_id: &str,
    provider: crate::instance::Provider,
    now: i64,
) -> Option<&'a T> {
    accounts.iter().find(|account| {
        account.id() != from_id
            && account.provider() == provider
            && availability(account.quota(), now) == Availability::Available
    })
}

#[cfg(test)]
mod tests {
    use indexmap::IndexMap;

    use super::*;
    use crate::quota::{AccountQuota, AuthState, Blockers, QuotaWindow, Usage};

    fn quota(
        auth: AuthState,
        observed_at: i64,
        windows: &[(&str, f64, Option<i64>)],
    ) -> AccountQuota {
        AccountQuota {
            auth,
            observed_at,
            windows: windows
                .iter()
                .map(|(name, used, resets)| {
                    (
                        (*name).to_string(),
                        QuotaWindow {
                            used_percent: *used,
                            resets_at: *resets,
                            remaining_percent: Some((100.0 - used).max(0.0)),
                            source: Some(crate::quota::WindowSource::Cli),
                            window_duration_mins: None,
                            limit_name: None,
                            observed_at: Some(observed_at),
                            advisory: false,
                        },
                    )
                })
                .collect::<IndexMap<_, _>>(),
            blockers: Blockers::default(),
            usage: Usage::default(),
            billing_mode: None,
            plan: None,
            reset_credits: None,
            cursor_sdk_auth: None,
        }
    }

    // packages/accounts/src/quota.process.test.ts
    // "Codex moves through available, near-limit and exhausted until the exact reset"
    #[test]
    fn codex_moves_through_available_near_limit_and_exhausted_until_the_exact_reset() {
        let now = 1_790_000_000_000;
        let soon = now + 20 * 60_000;
        assert_eq!(
            availability(
                &quota(AuthState::LoggedIn, now, &[("five_hour", 20.0, Some(soon))]),
                now
            ),
            Availability::Available
        );
        assert_eq!(
            availability(
                &quota(AuthState::LoggedIn, now, &[("five_hour", 80.0, Some(soon))]),
                now
            ),
            Availability::NearLimit
        );
        let exhausted = quota(
            AuthState::LoggedIn,
            now,
            &[("five_hour", 100.0, Some(soon))],
        );
        assert_eq!(availability(&exhausted, soon - 1), Availability::Exhausted);
        assert_eq!(availability(&exhausted, soon), Availability::Available);
    }

    // "a later reset on a second window keeps the account exhausted"
    #[test]
    fn a_later_reset_on_a_second_window_keeps_the_account_exhausted() {
        let now = 1_790_000_000_000;
        let state = quota(
            AuthState::LoggedIn,
            now,
            &[
                ("primary", 100.0, Some(now + 1_000)),
                ("secondary", 100.0, Some(now + 100_000)),
            ],
        );
        assert_eq!(availability(&state, now + 2_000), Availability::Exhausted);
        assert_eq!(availability(&state, now + 100_000), Availability::Available);
    }

    // "a rejection without a reported reset holds only while it is fresh"
    #[test]
    fn a_rejection_without_a_reported_reset_holds_only_while_it_is_fresh() {
        let now = 1_790_000_000_000;
        let mut state = quota(AuthState::LoggedIn, now, &[]);
        state.blockers.limit_error = Some(QuotaWindow {
            used_percent: 100.0,
            resets_at: None,
            remaining_percent: None,
            source: Some(crate::quota::WindowSource::LimitError),
            window_duration_mins: None,
            limit_name: None,
            observed_at: Some(now),
            advisory: false,
        });
        assert_eq!(availability(&state, now + 1), Availability::Exhausted);
        assert_eq!(
            availability(&state, now + 86_400_000),
            Availability::Available
        );
    }

    // "logged-out accounts stay unavailable even when quota has reset"
    #[test]
    fn logged_out_accounts_stay_unavailable_even_when_quota_has_reset() {
        let now = 1_790_000_000_000;
        let state = quota(
            AuthState::LoggedOut,
            now,
            &[("five_hour", 10.0, Some(now + 1))],
        );
        assert_eq!(
            availability(&state, now + 86_400_000),
            Availability::LoggedOut
        );
    }

    // "stale readings never hold an account at its limit"
    #[test]
    fn a_reading_older_than_thirty_minutes_never_holds_an_account() {
        let now = 1_790_000_000_000;
        let state = quota(
            AuthState::LoggedIn,
            now,
            &[("five_hour", 100.0, Some(now + 86_400_000))],
        );
        assert_eq!(
            availability(&state, now + STALE_READING_MS),
            Availability::Exhausted
        );
        assert_eq!(
            availability(&state, now + STALE_READING_MS + 1),
            Availability::Available
        );
    }

    // packages/accounts/src/quota.process.test.ts
    // "an unreadable home is unknown, and its windows still say when they reset"
    #[test]
    fn an_unreadable_home_is_unknown_and_its_windows_still_say_when_they_reset() {
        let now = 1_790_000_000_000;
        let mut state = quota(
            AuthState::LoggedIn,
            now,
            &[("five_hour", 100.0, Some(now + 1000))],
        );
        state.blockers.home_unavailable = Some("home_missing".into());
        assert_eq!(availability(&state, now), Availability::Unknown);
        // The quota itself is untouched by the home: only availability stops trusting it.
        assert_eq!(blocked_until(&state, now), Some(Some(now + 1000)));
    }

    #[test]
    fn blocked_until_is_the_last_reset_among_what_holds() {
        let now = 1_790_000_000_000;
        let state = quota(
            AuthState::LoggedIn,
            now,
            &[
                ("primary", 100.0, Some(now + 1_000)),
                ("secondary", 100.0, Some(now + 9_000)),
            ],
        );
        assert_eq!(blocked_until(&state, now), Some(Some(now + 9_000)));
    }
}
