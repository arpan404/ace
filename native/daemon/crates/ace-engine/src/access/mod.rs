// SPDX-License-Identifier: Apache-2.0
//! Access and approvals (E5.7): the four ace modes and each provider's native selector, the
//! durable permission row, the ancestry ceiling, the daemon's defaults, and the receipts that
//! change a thread's access. `approvals` holds ace's own approvals and the interaction ledger;
//! `hosts` holds the daemon's host and guest threads.

pub mod modes;
pub mod permissions;
pub mod storage;
pub mod target;

pub use modes::{
    AccessSelection, Identity, Offer, Policy, access_mode_offers, allowed_child_modes,
    ceiling_mode, custom_native, custom_selection, inherited_permission_mode, native_for,
    nearest_offer, offers_of, permission_within_ceiling, rank, stored_access, stricter_offer,
    supports_permission_mode,
};
pub use permissions::{Permissions, ResolvedAccess};
pub use storage::{PermissionRecord, PermissionState};
pub use target::{
    PermissionCatalog, Selection, access_mode, offered_modes, permission_target, target_instance,
};

/// The defaults a thread without its own choice follows: project, then this daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessDefaults {
    pub access: String,
    /// Settings → Providers → Advanced: a native mode the provider runs instead (Custom).
    pub custom: Option<String>,
}

/// ace's first-run access, used until the person chooses one on this daemon.
pub const FIRST_RUN_ACCESS: &str = "auto-review";

/// `accessDefaults` (`access-defaults.ts:11`): the project's default, else the daemon's, else the
/// first-run mode.
pub fn access_defaults(
    project: Option<&str>,
    daemon: Option<&str>,
    custom: Option<&str>,
) -> AccessDefaults {
    AccessDefaults {
        access: project.or(daemon).unwrap_or(FIRST_RUN_ACCESS).to_owned(),
        custom: custom.map(str::to_owned),
    }
}

/// `AccessError` (`permissions.ts:51`): the reason an access request was refused, as the code
/// clients read and the message the facade throws.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {detail}")]
pub struct AccessError {
    pub code: &'static str,
    pub detail: String,
}

impl AccessError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> AccessError {
        AccessError {
            code,
            detail: detail.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    //! `defaults.process.test.ts` and `client-model-defaults.process.test.ts` reach the
    //! project/daemon precedence through the engine; this pins the helper itself.

    use super::*;

    #[test]
    fn a_thread_without_its_own_choice_follows_its_project_then_the_daemon_then_the_first_run() {
        assert_eq!(
            access_defaults(Some("ask"), Some("full-access"), None).access,
            "ask"
        );
        assert_eq!(
            access_defaults(None, Some("full-access"), None).access,
            "full-access"
        );
        assert_eq!(access_defaults(None, None, None).access, FIRST_RUN_ACCESS);
        // An Advanced native override travels beside the ace default, as the settings read it.
        assert_eq!(
            access_defaults(None, None, Some("dontAsk"))
                .custom
                .as_deref(),
            Some("dontAsk")
        );
    }
}
