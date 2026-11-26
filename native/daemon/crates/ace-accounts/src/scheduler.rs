// SPDX-License-Identifier: Apache-2.0
//! Choosing the account automatic work runs on, from `packages/accounts/src/scheduler.ts`.

use ace_json::Value;

use crate::availability::{availability, blocked_until, Availability};
use crate::instance::{Provider, ProviderInstance};
use crate::quota::AccountQuota;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RolePolicy(pub std::collections::BTreeMap<String, String>);

#[derive(Clone, Debug)]
pub struct Candidate {
    pub instance: ProviderInstance,
    pub quota: AccountQuota,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpeedHint {
    pub service_tier: Option<&'static str>,
    pub fast_mode: bool,
}

fn string_bounded(value: Option<&Value>, max: usize) -> Option<&str> {
    let value = value.and_then(Value::as_str)?;
    (value.chars().count() <= max).then_some(value)
}

/// `speedHint`: only a role set to fast, and only where the provider's own catalog offers it.
pub fn speed_hint(
    provider: Provider,
    role: &str,
    model: &str,
    policy: &RolePolicy,
    codex_model_list: Option<&Value>,
    claude_fast_models: Option<&[String]>,
) -> SpeedHint {
    if policy.0.get(role).map(String::as_str) != Some("fast") {
        return SpeedHint::default();
    }
    if provider == Provider::Codex {
        if let Some(data) = codex_model_list
            .and_then(Value::as_object)
            .and_then(|list| list.get("data"))
            .and_then(Value::as_array)
        {
            if data.len() <= 256 {
                for value in data {
                    let Some(row) = value.as_object() else {
                        continue;
                    };
                    if string_bounded(row.get("model"), 256) != Some(model) {
                        continue;
                    }
                    let tiers = row.get("serviceTiers").and_then(Value::as_array);
                    if tiers.is_some_and(|tiers| {
                        tiers.len() <= 16
                            && tiers.iter().any(|tier| {
                                tier.as_object()
                                    .and_then(|tier| tier.get("id"))
                                    .and_then(Value::as_str)
                                    == Some("priority")
                            })
                    }) {
                        return SpeedHint {
                            service_tier: Some("priority"),
                            fast_mode: false,
                        };
                    }
                }
            }
        }
    }
    if provider == Provider::Claude
        && claude_fast_models.is_some_and(|models| models.len() <= 256 && models.iter().any(|m| m == model))
    {
        return SpeedHint {
            service_tier: None,
            fast_mode: true,
        };
    }
    SpeedHint::default()
}

pub struct Request<'a> {
    pub provider: Provider,
    pub role: &'a str,
    pub estimated_load: f64,
}

fn checked(input: &Request, count: usize) -> Result<(), crate::AccountsError> {
    if !input.estimated_load.is_finite()
        || input.estimated_load < 0.0
        || input.estimated_load > 100.0
    {
        return Err(crate::AccountsError::EstimatedLoad);
    }
    if count > 256 {
        return Err(crate::AccountsError::InstanceLimit);
    }
    Ok(())
}

/// The least room left in any live window, in percentage points, and the soonest reset.
fn room(quota: &AccountQuota, now: i64) -> (i64, f64) {
    let mut next_reset = i64::MAX;
    let mut headroom = 100.0f64;
    for window in quota.windows.values() {
        if window.resets_at.is_some_and(|resets_at| resets_at <= now) {
            continue;
        }
        headroom = headroom.min(100.0 - window.used_percent);
        if let Some(resets_at) = window.resets_at {
            next_reset = next_reset.min(resets_at);
        }
    }
    (next_reset, headroom)
}

/// The account automatic choice runs a child on.
pub fn pick_instance<'a>(
    input: &Request,
    candidates: &'a [Candidate],
    now: i64,
) -> Result<Option<&'a ProviderInstance>, crate::AccountsError> {
    checked(input, candidates.len())?;
    if input.provider == Provider::Acp {
        return Ok(None);
    }
    let mut best: Option<&ProviderInstance> = None;
    let mut best_reset = i64::MAX;
    let mut best_headroom = f64::NEG_INFINITY;
    let mut fallback: Option<&ProviderInstance> = None;
    let mut fallback_headroom = f64::NEG_INFINITY;
    for candidate in candidates {
        let instance = &candidate.instance;
        if instance.provider != input.provider {
            continue;
        }
        let level = availability(&candidate.quota, now);
        if level != Availability::Available && level != Availability::NearLimit {
            continue;
        }
        let (next_reset, headroom) = room(&candidate.quota, now);
        if fallback.is_none()
            || headroom > fallback_headroom
            || (headroom == fallback_headroom && fallback.is_some_and(|other| instance.id < other.id))
        {
            fallback = Some(instance);
            fallback_headroom = headroom;
        }
        if level != Availability::Available || headroom < input.estimated_load {
            continue;
        }
        if best.is_none()
            || next_reset < best_reset
            || (next_reset == best_reset
                && (headroom > best_headroom
                    || (headroom == best_headroom && best.is_some_and(|other| instance.id < other.id))))
        {
            best = Some(instance);
            best_reset = next_reset;
            best_headroom = headroom;
        }
    }
    Ok(best.or(fallback))
}

/// What definitely keeps an account from taking work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountRefusal {
    OtherProvider,
    HomeUnavailable,
    SignedOut,
    SignInUnconfirmed,
    /// `None` is the protocol's `null`: the provider did not say when it resets.
    AtLimit { until: Option<i64> },
}

/// What definitely keeps an account from working at `now`, or undefined when nothing does.
pub fn definite_refusal(
    provider: Provider,
    candidate: &Candidate,
    now: i64,
) -> Option<AccountRefusal> {
    let instance = &candidate.instance;
    if provider == Provider::Acp || instance.provider != provider {
        return Some(AccountRefusal::OtherProvider);
    }
    if candidate.quota.blockers.home_unavailable.is_some() {
        return Some(AccountRefusal::HomeUnavailable);
    }
    if candidate.quota.auth == crate::quota::AuthState::LoggedOut {
        return Some(AccountRefusal::SignedOut);
    }
    blocked_until(&candidate.quota, now).map(|until| AccountRefusal::AtLimit { until })
}

/// Why automatic choice passed an account over.
pub fn automatic_refusal(provider: Provider, candidate: &Candidate, now: i64) -> AccountRefusal {
    definite_refusal(provider, candidate, now).unwrap_or(AccountRefusal::SignInUnconfirmed)
}

/// An account the person or an agent named: it runs the work unless something definite blocks it.
pub fn explicit_instance<'a>(
    input: &Request,
    candidate: &'a Candidate,
    now: i64,
) -> Result<Result<&'a ProviderInstance, AccountRefusal>, crate::AccountsError> {
    checked(input, 1)?;
    Ok(match definite_refusal(input.provider, candidate, now) {
        Some(refusal) => Err(refusal),
        None => Ok(&candidate.instance),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instance::create_instance;

    const NOW: i64 = 1_790_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn worker(load: f64) -> Request<'static> {
        Request {
            provider: Provider::Codex,
            role: "worker",
            estimated_load: load,
        }
    }

    fn account(id: &str, used: Option<f64>, auth: crate::quota::AuthState) -> Candidate {
        let mut quota = crate::quota::initial_quota();
        quota.auth = auth;
        quota.observed_at = NOW;
        if let Some(used) = used {
            quota.windows.insert(
                "five_hour".into(),
                crate::quota::QuotaWindow {
                    used_percent: used,
                    resets_at: Some(NOW + HOUR),
                    remaining_percent: Some((100.0 - used).max(0.0)),
                    window_duration_mins: None,
                    source: Some(crate::quota::WindowSource::Cli),
                    limit_name: None,
                    observed_at: Some(NOW),
                    advisory: false,
                },
            );
        }
        Candidate {
            instance: create_instance(id, Provider::Codex, id, format!("/tmp/{id}")).expect("instance"),
            quota,
        }
    }

    // packages/accounts/src/scheduler.test.ts
    // "an account someone names runs the work while it is near its limit"
    #[test]
    fn an_account_someone_names_runs_the_work_while_it_is_near_its_limit() {
        let near = account("346", Some(92.0), crate::quota::AuthState::LoggedIn);
        assert!(explicit_instance(&worker(10.0), &near, NOW).is_ok_and(|result| result.is_ok()));
        assert!(explicit_instance(&worker(50.0), &near, NOW).is_ok_and(|result| result.is_ok()));
    }

    // "a named account whose sign-in isn't confirmed yet still runs the work"
    #[test]
    fn a_named_account_whose_sign_in_is_not_confirmed_yet_still_runs_the_work() {
        let unread = account("fresh", None, crate::quota::AuthState::Unknown);
        assert!(explicit_instance(&worker(10.0), &unread, NOW).is_ok_and(|result| result.is_ok()));
    }

    // "a named account at its limit is refused, saying until when"
    #[test]
    fn a_named_account_at_its_limit_is_refused_saying_until_when() {
        let full = account("346", Some(100.0), crate::quota::AuthState::LoggedIn);
        assert_eq!(
            explicit_instance(&worker(10.0), &full, NOW),
            Ok(Err(AccountRefusal::AtLimit {
                until: Some(NOW + HOUR)
            }))
        );
    }

    // "a named account that is signed out or has no usable home is refused for that reason"
    #[test]
    fn a_named_account_that_is_signed_out_or_has_no_usable_home_is_refused() {
        let out = account("out", Some(10.0), crate::quota::AuthState::LoggedOut);
        assert_eq!(
            explicit_instance(&worker(10.0), &out, NOW),
            Ok(Err(AccountRefusal::SignedOut))
        );
        let mut gone = account("gone", Some(10.0), crate::quota::AuthState::LoggedIn);
        gone.quota.blockers.home_unavailable = Some("home_missing".into());
        assert_eq!(
            explicit_instance(&worker(10.0), &gone, NOW),
            Ok(Err(AccountRefusal::HomeUnavailable))
        );
    }

    // "automatic choice prefers an available account over one near its limit"
    #[test]
    fn automatic_choice_prefers_an_available_account_over_one_near_its_limit() {
        let candidates = [
            account("near", Some(85.0), crate::quota::AuthState::LoggedIn),
            account("roomy", Some(40.0), crate::quota::AuthState::LoggedIn),
        ];
        assert_eq!(
            pick_instance(&worker(10.0), &candidates, NOW)
                .ok()
                .flatten()
                .map(|instance| instance.id.as_str()),
            Some("roomy")
        );
    }

    // "when every account is near its limit, automatic choice takes the one with most room"
    #[test]
    fn when_every_account_is_near_its_limit_it_takes_the_one_with_most_room() {
        let candidates = [
            account("a", Some(95.0), crate::quota::AuthState::LoggedIn),
            account("b", Some(82.0), crate::quota::AuthState::LoggedIn),
            account("c", Some(90.0), crate::quota::AuthState::LoggedIn),
        ];
        assert_eq!(
            pick_instance(&worker(10.0), &candidates, NOW)
                .ok()
                .flatten()
                .map(|instance| instance.id.as_str()),
            Some("b")
        );
    }

    // "automatic choice refuses only when no account is below its limit"
    #[test]
    fn automatic_choice_refuses_only_when_no_account_is_below_its_limit() {
        let candidates = [
            account("full", Some(100.0), crate::quota::AuthState::LoggedIn),
            account("out", Some(10.0), crate::quota::AuthState::LoggedOut),
            account("unread", None, crate::quota::AuthState::Unknown),
        ];
        assert_eq!(pick_instance(&worker(10.0), &candidates, NOW), Ok(None));
        let mut with_near = candidates.to_vec();
        with_near.push(account("near", Some(97.0), crate::quota::AuthState::LoggedIn));
        assert_eq!(
            pick_instance(&worker(10.0), &with_near, NOW)
                .ok()
                .flatten()
                .map(|instance| instance.id.as_str()),
            Some("near")
        );
    }

    #[test]
    fn an_estimated_load_outside_zero_to_one_hundred_and_an_oversized_list_are_refused() {
        let candidates = [account("a", Some(10.0), crate::quota::AuthState::LoggedIn)];
        assert_eq!(
            pick_instance(&worker(-1.0), &candidates, NOW),
            Err(crate::AccountsError::EstimatedLoad)
        );
        assert_eq!(
            pick_instance(&worker(101.0), &candidates, NOW),
            Err(crate::AccountsError::EstimatedLoad)
        );
        let many = vec![candidates[0].clone(); 257];
        assert_eq!(
            pick_instance(&worker(10.0), &many, NOW),
            Err(crate::AccountsError::InstanceLimit)
        );
    }
}
