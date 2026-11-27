// SPDX-License-Identifier: Apache-2.0
//! Provider sign-in as a session: one job per account, its progress, its cancellation and its
//! cleanup, ported from `packages/accounts/src/login-sessions.ts`, with the daemon's refusal
//! wording from `apps/daemon/src/services/login-refusal.ts`.
//!
//! Ephemeral challenges belong to the authenticated device: they are progress values here, never
//! logged or stored, and a pasted key or code is zeroed by [`ProviderLoginSessions::handle`] as
//! soon as the driver has taken it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub mod driver;
pub mod progress;
pub mod refusal;
pub mod sessions;

pub use driver::{
    LoginFuture, LoginInput, LoginOutcome, LoginUpdate, ProviderLoginDriver, ProviderLoginFailure,
};
pub use progress::{LoginAction, LoginChoice, LoginManual, LoginMethod, LoginProgress, LoginState};
pub use refusal::{LoginError, LoginReply};
pub use refusal::{LoginResult, LoginUnavailableReason, unavailable_login};
pub use sessions::{LoginHost, LoginRequest, LoginSessions, LoginTarget, LoginUpstream};

/// A cancellation flag a driver may check, cloned per job. It never wakes anything by itself:
/// drivers poll it where the TypeScript reads `signal.aborted`.
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn abort(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_aborted(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The wire's text limit for a message or prompt: 256 UTF-16 units, as the protocol counts them.
pub fn clip(text: &str) -> String {
    if text.encode_utf16().count() <= 256 {
        return text.to_string();
    }
    let mut units = 0;
    let mut end = 0;
    for (index, character) in text.char_indices() {
        let next = units + character.len_utf16();
        if next > 255 {
            break;
        }
        units = next;
        end = index + character.len_utf8();
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_message_is_clipped_to_the_contracts_limit() {
        assert_eq!(clip("short"), "short");
        // 200 accented characters are 200 UTF-16 units: the limit is not reached.
        assert_eq!(clip(&"é".repeat(200)), "é".repeat(200));
        let clipped = clip(&"x".repeat(300));
        assert_eq!(clipped.encode_utf16().count(), 256);
        assert!(clipped.ends_with('…'));
    }
}
