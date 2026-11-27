// SPDX-License-Identifier: Apache-2.0
//! Admission for the person's provider setup, ported from the daemon's socket services:
//! `provider-status.ts`, `provider-install.ts`, `provider-login.ts`, `accounts.ts` and the
//! onboarding service. Which scope a request needs, and what it is told when it cannot run,
//! is decided here; the services themselves do the work.
//!
//! The order is always the daemon's: a missing scope is `forbidden`, a service that isn't running
//! is `unavailable`, and a connection already holding eight requests is `busy`.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Read,
    Operate,
    Admin,
    Accounts,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Operate => "operate",
            Scope::Admin => "admin",
            Scope::Accounts => "accounts",
        }
    }
}

/// What one connection may do.
#[derive(Clone, Copy, Debug, Default)]
pub struct Grants {
    pub read: bool,
    pub operate: bool,
    pub admin: bool,
    pub accounts: bool,
    /// This connection may hand over a secret (an API key), not only read progress.
    pub submit_secret: bool,
}

impl Grants {
    pub fn allows(&self, scope: Scope) -> bool {
        match scope {
            Scope::Read => self.read,
            Scope::Operate => self.operate,
            Scope::Admin => self.admin,
            Scope::Accounts => self.accounts,
        }
    }
}

/// Which setup services are running.
#[derive(Clone, Copy, Debug, Default)]
pub struct Availability {
    pub statuses: bool,
    pub installs: bool,
    pub login: bool,
    pub onboarding: bool,
    pub accounts: bool,
    pub account_management: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProvidersOperation {
    List,
    Readiness,
    Refresh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallOperation {
    /// A plan or a run. A registry target (Antigravity, or an ACP agent id) also writes the
    /// account registry, so it needs `admin`.
    Plan,
    Run,
    /// Polling, reattaching and cancelling only read or stop a job this device started.
    Poll,
    Active,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginOperation {
    Start,
    Logout,
    /// Continuation input: a code, a return address, a choice or a confirmation.
    Input,
    ApiKey,
    Cancel,
    /// A progress read or a terminal lookup.
    Read,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnboardingOperation {
    Query,
    Dismiss,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountsOperation {
    List,
    Status,
    Migrate,
    ConsumeReset,
    RefreshLimits,
    /// `accounts.*` management requests (`AccountManagementRequest`), requiring `accounts` scope.
    Manage,
    /// `provider.accounts.list`.
    ProviderList,
    /// `provider.accounts.{add,rename,setDefault,remove,reauth}`, requiring `operate` scope.
    ProviderManage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupRequest {
    Providers(ProvidersOperation),
    /// The second flag marks a registry target (Antigravity or an ACP agent id).
    Install(InstallOperation, bool),
    Login(LoginOperation),
    Onboarding(OnboardingOperation),
    Accounts(AccountsOperation),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Admit {
        scope: Scope,
    },
    Refuse {
        code: &'static str,
        detail: &'static str,
    },
}

const BUSY_DETAIL: &str = "Too many requests on this connection";

/// Decides one request. `pending` counts the requests this connection already has running.
pub fn admit(
    request: SetupRequest,
    grants: Grants,
    available: Availability,
    pending: u32,
) -> Decision {
    match request {
        SetupRequest::Providers(operation) => {
            let scope = if operation == ProvidersOperation::Refresh {
                Scope::Operate
            } else {
                Scope::Read
            };
            refuse_unless(grants, scope)
                .or_else(|| unavailable(!available.statuses))
                .or_else(|| busy(pending))
                .unwrap_or(Decision::Admit { scope })
        }
        SetupRequest::Install(_operation, registry) => {
            if !grants.operate || (registry && !grants.admin) {
                return refuse(Scope::Operate);
            }
            unavailable(!available.installs)
                .or_else(|| busy(pending))
                .unwrap_or(Decision::Admit {
                    scope: if registry {
                        Scope::Admin
                    } else {
                        Scope::Operate
                    },
                })
        }
        SetupRequest::Login(operation) => {
            if !grants.operate || (operation == LoginOperation::ApiKey && !grants.submit_secret) {
                return refuse(Scope::Operate);
            }
            unavailable(!available.login)
                .or_else(|| busy(pending))
                .unwrap_or(Decision::Admit {
                    scope: Scope::Operate,
                })
        }
        SetupRequest::Onboarding(operation) => {
            let scope = if operation == OnboardingOperation::Dismiss {
                Scope::Operate
            } else {
                Scope::Read
            };
            refuse_unless(grants, scope)
                .or_else(|| unavailable(!available.onboarding))
                .unwrap_or(Decision::Admit { scope })
        }
        SetupRequest::Accounts(operation) => accounts(operation, grants, available, pending),
    }
}

fn accounts(
    operation: AccountsOperation,
    grants: Grants,
    available: Availability,
    pending: u32,
) -> Decision {
    match operation {
        AccountsOperation::ProviderList | AccountsOperation::ProviderManage => {
            let scope = if operation == AccountsOperation::ProviderList {
                Scope::Read
            } else {
                Scope::Operate
            };
            refuse_unless(grants, scope)
                .or_else(|| unavailable(!available.account_management || !available.login))
                .or_else(|| busy(pending))
                .unwrap_or(Decision::Admit { scope })
        }
        AccountsOperation::ConsumeReset => {
            let scope = Scope::Operate;
            if !grants.allows(scope) {
                return refuse(scope);
            }
            if !available.account_management || pending >= 8 {
                return Decision::Refuse {
                    code: "accounts_busy",
                    detail: "Account reset unavailable",
                };
            }
            Decision::Admit { scope }
        }
        AccountsOperation::RefreshLimits => {
            let scope = Scope::Read;
            if !grants.allows(scope) {
                return refuse(scope);
            }
            if !available.accounts {
                return Decision::Refuse {
                    code: "accounts_unavailable",
                    detail: "Accounts service is unavailable",
                };
            }
            Decision::Admit { scope }
        }
        AccountsOperation::List
        | AccountsOperation::Status
        | AccountsOperation::Migrate
        | AccountsOperation::Manage => {
            let scope = match operation {
                AccountsOperation::Manage => Scope::Accounts,
                AccountsOperation::Migrate => Scope::Operate,
                _ => Scope::Read,
            };
            if !grants.allows(scope) {
                return refuse(scope);
            }
            let management_needed = operation == AccountsOperation::Manage;
            if !available.accounts || (management_needed && !available.account_management) {
                return Decision::Refuse {
                    code: "accounts_unavailable",
                    detail: "Accounts service is unavailable",
                };
            }
            if pending >= 8 {
                return Decision::Refuse {
                    code: "accounts_busy",
                    detail: "Too many account requests",
                };
            }
            Decision::Admit { scope }
        }
    }
}

fn refuse(scope: Scope) -> Decision {
    Decision::Refuse {
        code: "forbidden",
        detail: match scope {
            Scope::Read => "read scope required",
            Scope::Operate => "operate scope required",
            Scope::Admin => "admin scope required",
            Scope::Accounts => "accounts scope required",
        },
    }
}

fn refuse_unless(grants: Grants, scope: Scope) -> Option<Decision> {
    (!grants.allows(scope)).then(|| refuse(scope))
}

fn unavailable(missing: bool) -> Option<Decision> {
    missing.then_some(Decision::Refuse {
        code: "unavailable",
        detail: "This service is not running",
    })
}

fn busy(pending: u32) -> Option<Decision> {
    (pending >= 8).then_some(Decision::Refuse {
        code: "busy",
        detail: BUSY_DETAIL,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running() -> Availability {
        Availability {
            statuses: true,
            installs: true,
            login: true,
            onboarding: true,
            accounts: true,
            account_management: true,
        }
    }

    fn read_only() -> Grants {
        Grants {
            read: true,
            ..Default::default()
        }
    }

    fn operator() -> Grants {
        Grants {
            read: true,
            operate: true,
            submit_secret: true,
            ..Default::default()
        }
    }

    fn admin() -> Grants {
        Grants {
            admin: true,
            ..operator()
        }
    }

    // apps/daemon/src/provider-login.server.process.test.ts
    // "read-only paired devices cannot start, inspect, or cancel provider login sessions"
    #[test]
    fn read_only_devices_cannot_start_inspect_or_cancel_provider_login_sessions() {
        for operation in [
            LoginOperation::Start,
            LoginOperation::Logout,
            LoginOperation::Input,
            LoginOperation::ApiKey,
            LoginOperation::Cancel,
            LoginOperation::Read,
        ] {
            assert_eq!(
                admit(SetupRequest::Login(operation), read_only(), running(), 0),
                Decision::Refuse {
                    code: "forbidden",
                    detail: "operate scope required"
                }
            );
        }
        // Holding the scope is not enough to hand over a secret.
        let no_secret = Grants {
            submit_secret: false,
            ..operator()
        };
        assert_eq!(
            admit(
                SetupRequest::Login(LoginOperation::ApiKey),
                no_secret,
                running(),
                0
            ),
            Decision::Refuse {
                code: "forbidden",
                detail: "operate scope required"
            }
        );
    }

    // "operate clients receive installer progress, can poll after reconnect, and receive refreshed readiness"
    #[test]
    fn operate_clients_can_place_poll_and_cancel_installs() {
        for operation in [
            InstallOperation::Plan,
            InstallOperation::Run,
            InstallOperation::Poll,
            InstallOperation::Active,
            InstallOperation::Cancel,
        ] {
            assert_eq!(
                admit(
                    SetupRequest::Install(operation, false),
                    operator(),
                    running(),
                    0
                ),
                Decision::Admit {
                    scope: Scope::Operate
                }
            );
        }
    }

    // "read-only devices cannot plan, run, poll or cancel and receive no installer progress"
    #[test]
    fn read_only_devices_cannot_plan_run_poll_or_cancel_installs() {
        for operation in [
            InstallOperation::Plan,
            InstallOperation::Run,
            InstallOperation::Poll,
            InstallOperation::Active,
            InstallOperation::Cancel,
        ] {
            assert_eq!(
                admit(
                    SetupRequest::Install(operation, false),
                    read_only(),
                    running(),
                    0
                ),
                Decision::Refuse {
                    code: "forbidden",
                    detail: "operate scope required"
                }
            );
        }
    }

    // "a registry target writes the account registry, so it needs admin as well"
    #[test]
    fn a_registry_install_needs_admin_as_well_as_operate() {
        assert_eq!(
            admit(
                SetupRequest::Install(InstallOperation::Run, true),
                operator(),
                running(),
                0
            ),
            Decision::Refuse {
                code: "forbidden",
                detail: "operate scope required"
            }
        );
        assert_eq!(
            admit(
                SetupRequest::Install(InstallOperation::Run, true),
                admin(),
                running(),
                0
            ),
            Decision::Admit {
                scope: Scope::Admin
            }
        );
    }

    // "paired read devices can inspect accounts but migration requires operate scope"
    #[test]
    fn paired_read_devices_can_inspect_accounts_but_migration_needs_operate() {
        for operation in [
            AccountsOperation::List,
            AccountsOperation::Status,
            AccountsOperation::RefreshLimits,
            AccountsOperation::ProviderList,
        ] {
            assert_eq!(
                admit(SetupRequest::Accounts(operation), read_only(), running(), 0),
                Decision::Admit { scope: Scope::Read }
            );
        }
        assert_eq!(
            admit(
                SetupRequest::Accounts(AccountsOperation::Migrate),
                read_only(),
                running(),
                0
            ),
            Decision::Refuse {
                code: "forbidden",
                detail: "operate scope required"
            }
        );
        assert_eq!(
            admit(
                SetupRequest::Accounts(AccountsOperation::Migrate),
                operator(),
                running(),
                0
            ),
            Decision::Admit {
                scope: Scope::Operate
            }
        );
    }

    // "provider status reports native installation and sign-in independently of ace accounts and refreshes a cached result"
    #[test]
    fn provider_status_reads_with_read_and_refreshes_with_operate() {
        assert_eq!(
            admit(
                SetupRequest::Providers(ProvidersOperation::List),
                read_only(),
                running(),
                0
            ),
            Decision::Admit { scope: Scope::Read }
        );
        assert_eq!(
            admit(
                SetupRequest::Providers(ProvidersOperation::Readiness),
                read_only(),
                running(),
                0
            ),
            Decision::Admit { scope: Scope::Read }
        );
        assert_eq!(
            admit(
                SetupRequest::Providers(ProvidersOperation::Refresh),
                read_only(),
                running(),
                0
            ),
            Decision::Refuse {
                code: "forbidden",
                detail: "operate scope required"
            }
        );
        assert_eq!(
            admit(
                SetupRequest::Providers(ProvidersOperation::Refresh),
                operator(),
                running(),
                0
            ),
            Decision::Admit {
                scope: Scope::Operate
            }
        );
    }

    #[test]
    fn onboarding_queries_read_and_dismissals_operate() {
        assert_eq!(
            admit(
                SetupRequest::Onboarding(OnboardingOperation::Query),
                read_only(),
                running(),
                0
            ),
            Decision::Admit { scope: Scope::Read }
        );
        assert_eq!(
            admit(
                SetupRequest::Onboarding(OnboardingOperation::Dismiss),
                read_only(),
                running(),
                0
            ),
            Decision::Refuse {
                code: "forbidden",
                detail: "operate scope required"
            }
        );
        assert_eq!(
            admit(
                SetupRequest::Onboarding(OnboardingOperation::Dismiss),
                operator(),
                running(),
                0
            ),
            Decision::Admit {
                scope: Scope::Operate
            }
        );
    }

    #[test]
    fn a_stopped_service_says_so_before_busy_does() {
        let stopped = Availability::default();
        assert_eq!(
            admit(
                SetupRequest::Providers(ProvidersOperation::List),
                read_only(),
                stopped,
                8
            ),
            Decision::Refuse {
                code: "unavailable",
                detail: "This service is not running"
            }
        );
        assert_eq!(
            admit(
                SetupRequest::Login(LoginOperation::Start),
                operator(),
                stopped,
                0
            ),
            Decision::Refuse {
                code: "unavailable",
                detail: "This service is not running"
            }
        );
        // Accounts use their own code, and a management request needs the manager too.
        assert_eq!(
            admit(
                SetupRequest::Accounts(AccountsOperation::List),
                read_only(),
                stopped,
                0
            ),
            Decision::Refuse {
                code: "accounts_unavailable",
                detail: "Accounts service is unavailable"
            }
        );
    }

    #[test]
    fn eight_pending_requests_make_the_connection_busy() {
        assert_eq!(
            admit(
                SetupRequest::Providers(ProvidersOperation::List),
                read_only(),
                running(),
                7
            ),
            Decision::Admit { scope: Scope::Read }
        );
        assert_eq!(
            admit(
                SetupRequest::Providers(ProvidersOperation::List),
                read_only(),
                running(),
                8
            ),
            Decision::Refuse {
                code: "busy",
                detail: BUSY_DETAIL
            }
        );
        assert_eq!(
            admit(
                SetupRequest::Login(LoginOperation::Start),
                operator(),
                running(),
                8
            ),
            Decision::Refuse {
                code: "busy",
                detail: BUSY_DETAIL
            }
        );
        assert_eq!(
            admit(
                SetupRequest::Accounts(AccountsOperation::List),
                read_only(),
                running(),
                8
            ),
            Decision::Refuse {
                code: "accounts_busy",
                detail: "Too many account requests"
            }
        );
    }

    #[test]
    fn account_management_requires_accounts_scope_not_only_operate() {
        assert_eq!(
            admit(
                SetupRequest::Accounts(AccountsOperation::Manage),
                operator(),
                running(),
                0
            ),
            Decision::Refuse {
                code: "forbidden",
                detail: "accounts scope required"
            }
        );
        let with_accounts = Grants {
            accounts: true,
            ..operator()
        };
        assert_eq!(
            admit(
                SetupRequest::Accounts(AccountsOperation::Manage),
                with_accounts,
                running(),
                0
            ),
            Decision::Admit {
                scope: Scope::Accounts
            }
        );
        assert_eq!(
            admit(
                SetupRequest::Accounts(AccountsOperation::Manage),
                with_accounts,
                running(),
                8
            ),
            Decision::Refuse {
                code: "accounts_busy",
                detail: "Too many account requests"
            }
        );
    }
}
