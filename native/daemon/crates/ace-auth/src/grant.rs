// SPDX-License-Identifier: Apache-2.0
//! An account socket's grant (`account-access/grant-lease.ts`, `grant-socket.ts`): it is held
//! until its expiry plus a short grace, `account.grant.refresh` moves the expiry on through a new
//! admission, and a grant for another account, another role or a refused admission ends it.

use std::sync::Arc;

/// How long past its grant's expiry an account socket may stay open while its refresh is on the
/// way.
pub const GRANT_GRACE_MS: i64 = 30_000;
/// The close code for an account socket whose grant ran out: not final, the client reconnects.
pub const GRANT_EXPIRED_CLOSE: u16 = 4014;
pub const GRANT_EXPIRED_REASON: &str = "Account grant expired";
/// The close code for a socket whose account access changed (signed out, moved account, new
/// machine code).
pub const ACCESS_CHANGED_CLOSE: u16 = 4012;
pub const ACCESS_CHANGED_REASON: &str = "Account access changed";

/// A member's socket on an organization's host: the organization and role it was admitted with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantMember {
    pub org: String,
    pub role: String,
}

/// Whether an account socket still holds a grant at `now`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseState {
    Held,
    Expired,
}

impl LeaseState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Held => "held",
            Self::Expired => "expired",
        }
    }
}

pub fn grant_lease_state(expires_at: i64, now: i64, grace_ms: i64) -> LeaseState {
    if now < expires_at + grace_ms {
        LeaseState::Held
    } else {
        LeaseState::Expired
    }
}

/// How the machine judged a new grant (`admitDevice`): an account and expiry, or the refusal the
/// client is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceAdmission {
    Admitted {
        account: String,
        expires_at: i64,
        person: bool,
        member: Option<GrantMember>,
    },
    Refused {
        code: String,
        message: String,
    },
}

/// What a socket's `account.grant.refresh` does, given how the machine judged the new grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantRefreshOutcome {
    Extended { expires_at: i64 },
    Refused { code: String, message: String },
}

/// The refresh rule (`grant-lease.ts:41`–`:60`): the socket keeps the account it was admitted
/// for, a grant that would end sooner never shortens the one held, and a member's changed role
/// is refused so the client reconnects with the new one.
pub fn grant_refresh_outcome(
    admission: &DeviceAdmission,
    account: &str,
    held_until: i64,
    member: Option<&GrantMember>,
) -> GrantRefreshOutcome {
    let (admitted_account, expires_at, admitted_member) = match admission {
        DeviceAdmission::Refused { code, message } => {
            return GrantRefreshOutcome::Refused {
                code: code.clone(),
                message: message.clone(),
            };
        }
        DeviceAdmission::Admitted {
            account,
            expires_at,
            member,
            ..
        } => (account, *expires_at, member.as_ref()),
    };
    if admitted_account != account {
        return GrantRefreshOutcome::Refused {
            code: "unauthorized".to_owned(),
            message: "That grant is for another account.".to_owned(),
        };
    }
    let changed = admitted_member.map(|each| (&each.org, &each.role))
        != member.map(|each| (&each.org, &each.role));
    if changed {
        return GrantRefreshOutcome::Refused {
            code: "unauthorized".to_owned(),
            message: "Your role here changed.".to_owned(),
        };
    }
    GrantRefreshOutcome::Extended {
        expires_at: held_until.max(expires_at),
    }
}

/// The answer a refresh sends: `account.grant.refresh.result`'s `result`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantRefreshResult {
    Ok { grant_ttl_ms: i64 },
    Refused { code: String, message: String },
}

/// One account socket's grant (`grant-socket.ts:12`). The machine's admission arrives as a
/// value, so the lease itself does no I/O.
pub struct AccountGrantSocket {
    expires_at: i64,
    account: String,
    device_id: String,
    member: Option<GrantMember>,
    machine_available: bool,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl AccountGrantSocket {
    pub fn new(
        expires_at: i64,
        account: impl Into<String>,
        device_id: impl Into<String>,
        member: Option<GrantMember>,
        machine_available: bool,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            expires_at,
            account: account.into(),
            device_id: device_id.into(),
            member,
            machine_available,
            now,
        }
    }

    /// How long the socket's grant has left, for the welcome and each refresh's answer.
    pub fn ttl_ms(&self) -> i64 {
        (self.expires_at - (self.now)()).max(0)
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// The grant ran out and its grace passed: the socket must close.
    pub fn expired(&self) -> bool {
        grant_lease_state(self.expires_at, (self.now)(), GRANT_GRACE_MS) == LeaseState::Expired
    }

    /// `account.grant.refresh`: the machine admits the new grant, then the socket decides.
    pub fn refresh(&mut self, admission: &DeviceAdmission) -> GrantRefreshResult {
        if !self.machine_available {
            return GrantRefreshResult::Refused {
                code: "unauthorized".to_owned(),
                message: "ace account is unavailable.".to_owned(),
            };
        }
        match grant_refresh_outcome(
            admission,
            &self.account,
            self.expires_at,
            self.member.as_ref(),
        ) {
            GrantRefreshOutcome::Refused { code, message } => {
                GrantRefreshResult::Refused { code, message }
            }
            GrantRefreshOutcome::Extended { expires_at } => {
                self.expires_at = expires_at;
                GrantRefreshResult::Ok {
                    grant_ttl_ms: self.ttl_ms(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/account-access/grant-lease.test.ts`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{
        DeviceAdmission, GRANT_GRACE_MS, GrantMember, GrantRefreshOutcome, LeaseState,
        grant_lease_state, grant_refresh_outcome,
    };

    #[test]
    fn an_account_sockets_grant_is_held_until_its_expiry_plus_the_grace() {
        for (now, state) in [
            (1_000, LeaseState::Held),
            (10_000, LeaseState::Held),
            (10_000 + GRANT_GRACE_MS - 1, LeaseState::Held),
            (10_000 + GRANT_GRACE_MS, LeaseState::Expired),
            (10_000_000, LeaseState::Expired),
        ] {
            assert_eq!(
                grant_lease_state(10_000, now, GRANT_GRACE_MS),
                state,
                "{now}"
            );
        }
    }

    #[test]
    fn the_grace_is_the_one_it_is_given() {
        assert_eq!(grant_lease_state(10_000, 10_000, 0), LeaseState::Expired);
        assert_eq!(grant_lease_state(10_000, 10_999, 1_000), LeaseState::Held);
    }

    fn admitted(account: &str, expires_at: i64) -> DeviceAdmission {
        DeviceAdmission::Admitted {
            account: account.to_owned(),
            expires_at,
            person: false,
            member: None,
        }
    }

    #[test]
    fn a_fresh_grant_for_the_same_account_moves_the_expiry_on() {
        assert_eq!(
            grant_refresh_outcome(&admitted("user_a", 50_000), "user_a", 20_000, None),
            GrantRefreshOutcome::Extended { expires_at: 50_000 }
        );
    }

    #[test]
    fn a_grant_that_ends_sooner_never_shortens_the_one_held() {
        assert_eq!(
            grant_refresh_outcome(&admitted("user_a", 15_000), "user_a", 20_000, None),
            GrantRefreshOutcome::Extended { expires_at: 20_000 }
        );
    }

    #[test]
    fn a_grant_for_another_account_is_refused() {
        let outcome = grant_refresh_outcome(&admitted("user_b", 50_000), "user_a", 20_000, None);
        assert!(matches!(
            outcome,
            GrantRefreshOutcome::Refused { ref code, .. } if code == "unauthorized"
        ));
    }

    #[test]
    fn a_grant_the_machine_refuses_is_refused_with_its_reason() {
        let refused = DeviceAdmission::Refused {
            code: "machine_code_required".to_owned(),
            message: "Enter this machine's code.".to_owned(),
        };
        assert_eq!(
            grant_refresh_outcome(&refused, "user_a", 20_000, None),
            GrantRefreshOutcome::Refused {
                code: "machine_code_required".to_owned(),
                message: "Enter this machine's code.".to_owned(),
            }
        );
    }

    fn member(role: &str) -> DeviceAdmission {
        DeviceAdmission::Admitted {
            account: "user_m".to_owned(),
            expires_at: 50_000,
            person: false,
            member: Some(GrantMember {
                org: "org_team".to_owned(),
                role: role.to_owned(),
            }),
        }
    }

    #[test]
    fn a_members_same_role_moves_the_expiry_on_and_a_changed_role_is_refused() {
        assert_eq!(
            grant_refresh_outcome(
                &member("member"),
                "user_m",
                10_000,
                Some(&GrantMember {
                    org: "org_team".to_owned(),
                    role: "member".to_owned(),
                })
            ),
            GrantRefreshOutcome::Extended { expires_at: 50_000 }
        );
        assert!(matches!(
            grant_refresh_outcome(
                &member("admin"),
                "user_m",
                10_000,
                Some(&GrantMember {
                    org: "org_team".to_owned(),
                    role: "member".to_owned(),
                })
            ),
            GrantRefreshOutcome::Refused { .. }
        ));
    }

    #[test]
    fn a_member_grant_on_a_socket_admitted_without_one_is_refused() {
        assert!(matches!(
            grant_refresh_outcome(&member("member"), "user_m", 10_000, None),
            GrantRefreshOutcome::Refused { .. }
        ));
    }
}
