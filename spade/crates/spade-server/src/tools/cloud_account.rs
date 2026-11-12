//! The ace account credential Spade shows Spade Cloud (ADR 0139): a machine grant from the
//! daemon, kept in memory until a minute before it runs out so polling a sign-in doesn't ask the
//! daemon every few seconds. Never written anywhere.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use spade_ace::AccountError;
use spade_connect::{AccountCredential, AccountProblem, Credential};

use super::AceLink;

/// How long before a grant runs out a new one is asked for.
const RENEW_AHEAD: Duration = Duration::from_secs(60);

pub struct CloudAccount {
    link: Option<Arc<AceLink>>,
    held: Mutex<Option<(spade_ace::Secret, Instant)>>,
}

impl CloudAccount {
    /// `None` when Spade runs without ace: every sign-in through the cloud then says to sign in.
    pub fn new(link: Option<Arc<AceLink>>) -> Self {
        Self {
            link,
            held: Mutex::new(None),
        }
    }
}

impl AccountCredential for CloudAccount {
    fn grant(&self) -> Credential<'_> {
        Box::pin(async move {
            if let Some((token, until)) =
                self.held.lock().unwrap_or_else(|p| p.into_inner()).as_ref()
                && Instant::now() < *until
            {
                return Ok(token.expose().to_owned());
            }
            let link = self.link.as_ref().ok_or(AccountProblem::SignedOut)?;
            let account = link.account().map_err(AccountProblem::Unreachable)?;
            let grant = account.grant().await.map_err(|error| match error {
                AccountError::SignedOut => AccountProblem::SignedOut,
                AccountError::Unreachable(why) => AccountProblem::Unreachable(why),
            })?;
            let keep = grant.lifetime.saturating_sub(RENEW_AHEAD);
            if !keep.is_zero() {
                *self.held.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some((grant.token.clone(), Instant::now() + keep));
            }
            Ok(grant.token.expose().to_owned())
        })
    }
}
