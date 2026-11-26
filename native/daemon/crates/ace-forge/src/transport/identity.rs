// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Identity pinning (`pinned-runner.ts`, `readiness.ts`'s identity probe): pinned requests
//! are admitted only as the account the person chose, and a probe that names another account
//! fails closed. Reads reuse a verification for 60 s; every write is verified immediately
//! before dispatch, and a write whose post-probe names another account reports
//! `identityChanged` instead of hiding the switch.
//!
//! The TypeScript runs a read *beside* its probe so the read's own latency hides the probe's;
//! this port verifies first and then reads, so the observable outcomes (the window, the
//! fail-closed mismatch, `identityChanged`) are the same and the request is one process.

use std::sync::Mutex;

use crate::transport::command::{Cancellation, CommandRequest, CommandResult, Runner};
use crate::transport::error::{ForgeError, Kind};
use crate::transport::http::GhApi;
use crate::transport::mutation::is_forge_mutation;

/// How long a verified identity admits reads without another probe.
pub const IDENTITY_VERIFICATION_MS: f64 = 60_000.0;

/// The predicate naming the requests a runner pins (`PinnedRunnerInput.pins`).
pub type Pins = Box<dyn Fn(&CommandRequest) -> bool + Send + Sync>;
/// The caller's own preference check (`PinnedRunnerInput.assertCurrent`).
pub type AssertCurrent = Box<dyn Fn() -> Result<(), ForgeError> + Send + Sync>;

/// Whether `login` is the shape the schemas accept: a letter or digit, then letters, digits
/// or hyphens, at most 100 characters.
pub fn valid_login(login: &str) -> bool {
    let mut characters = login.chars();
    login.chars().count() <= 100
        && characters
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// Whether a verification at `verified_at` still admits reads at `now`.
pub fn identity_is_fresh(verified_at: Option<f64>, now: f64, ttl_ms: f64) -> bool {
    match verified_at {
        Some(at) => {
            let age = now - at;
            age >= 0.0 && age < ttl_ms
        }
        None => false,
    }
}

/// A runner that pins every request the caller names to one admitted account.
pub struct Pinned<'a> {
    runner: &'a dyn Runner,
    account: String,
    host: String,
    now: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>,
    verified_at: Mutex<Option<f64>>,
    ttl_ms: f64,
    on_verified: Option<Box<dyn Fn(f64) + Send + Sync>>,
    on_mismatch: Option<Box<dyn Fn() + Send + Sync>>,
    pins: Option<Pins>,
    assert_current: Option<AssertCurrent>,
}

impl<'a> Pinned<'a> {
    /// Pins every `gh` request to `account`; `verified_at` is the caller's own window, when
    /// the caller verified the account itself already.
    pub fn new(
        runner: &'a dyn Runner,
        host: impl Into<String>,
        account: impl Into<String>,
        now: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>,
        verified_at: Option<f64>,
    ) -> Pinned<'a> {
        Pinned {
            runner,
            account: account.into(),
            host: host.into(),
            now,
            verified_at: Mutex::new(verified_at),
            ttl_ms: IDENTITY_VERIFICATION_MS,
            on_verified: None,
            on_mismatch: None,
            pins: None,
            assert_current: None,
        }
    }

    /// A shorter or longer verification window (tests).
    pub fn ttl_ms(mut self, ttl_ms: f64) -> Pinned<'a> {
        self.ttl_ms = ttl_ms;
        self
    }

    /// Each successful probe, so the caller's own window moves with it.
    pub fn on_verified(mut self, on_verified: Box<dyn Fn(f64) + Send + Sync>) -> Pinned<'a> {
        self.on_verified = Some(on_verified);
        self
    }

    /// A probe named another account: the caller's window must not admit it again.
    pub fn on_mismatch(mut self, on_mismatch: Box<dyn Fn() + Send + Sync>) -> Pinned<'a> {
        self.on_mismatch = Some(on_mismatch);
        self
    }

    /// Requests this runner pins; any other passes straight through (`pinned-runner.ts:71`).
    pub fn pins(mut self, pins: Pins) -> Pinned<'a> {
        self.pins = Some(pins);
        self
    }

    /// The caller's own preference check (`assertCurrent`): asked before a pinned request and
    /// again after it, so a preference that moved during a write marks the result.
    pub fn assert_current(mut self, assert_current: AssertCurrent) -> Pinned<'a> {
        self.assert_current = Some(assert_current);
        self
    }

    fn current(&self) -> Result<(), ForgeError> {
        match &self.assert_current {
            Some(assert_current) => assert_current(),
            None => Ok(()),
        }
    }

    fn fresh(&self) -> bool {
        identity_is_fresh(
            *self.verified_at.lock().expect("window lock"),
            (self.now)(),
            self.ttl_ms,
        )
    }

    fn verified(&self) {
        let at = (self.now)();
        *self.verified_at.lock().expect("window lock") = Some(at);
        if let Some(on_verified) = &self.on_verified {
            on_verified(at);
        }
    }

    /// The CLI's current API account.
    async fn identify(&self, request: &CommandRequest) -> Result<String, ForgeError> {
        let api = GhApi::new(self.runner, self.host.clone(), self.now.clone());
        let page = api
            .request(
                "user",
                None,
                None,
                request.cancellation.clone(),
                Default::default(),
            )
            .await?;
        let login = page
            .body
            .as_object()
            .and_then(|fields| fields.get("login"))
            .and_then(|login| login.as_str())
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        if !valid_login(login) {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        Ok(login.to_owned())
    }

    async fn verify(&self, request: &CommandRequest) -> Result<(), ForgeError> {
        if self.identify(request).await? != self.account {
            *self.verified_at.lock().expect("window lock") = None;
            if let Some(on_mismatch) = &self.on_mismatch {
                on_mismatch();
            }
            return Err(ForgeError::new(Kind::Forbidden));
        }
        self.verified();
        Ok(())
    }

    /// Runs one request under the pin, or fails closed.
    pub async fn run(&self, request: CommandRequest) -> Result<CommandResult, ForgeError> {
        self.current()?;
        let pinned = match &self.pins {
            Some(pins) => pins(&request),
            None => request.command == "gh",
        };
        if !pinned {
            return self.runner.run(request).await;
        }
        let write = is_forge_mutation(&request);
        if write {
            self.verify(&request).await?;
            // The selection may have moved while the probe ran: recheck before dispatch.
            self.current()?;
            let result = self.runner.run(request.clone()).await;
            let mut result = match result {
                Ok(result) => result,
                // A dispatched write keeps its error.
                Err(error) => return Err(error),
            };
            // Only a confirmed different account makes the outcome uncertain; an unavailable
            // probe proves nothing.
            if let Ok(account) = self.identify(&request).await {
                if account != self.account {
                    result.identity_changed = true;
                } else {
                    self.verified();
                }
            }
            // Preferences may change while the write is in flight: a moved selection makes
            // the result uncertain rather than publishing it under an account nobody chose.
            if self.current().is_err() {
                result.identity_changed = true;
            }
            return Ok(result);
        }
        if !self.fresh() {
            // A read has no effect: it runs beside its probe, and its answer is only returned
            // once the probe proves the account it was read as (`pinned-runner.ts:89-98`).
            let (checked, read) =
                tokio::join!(self.verify(&request), self.runner.run(request.clone()));
            checked?;
            self.current()?;
            return read;
        }
        let result = self.runner.run(request).await?;
        self.current()?;
        Ok(result)
    }
}

impl Runner for Pinned<'_> {
    fn run<'a>(
        &'a self,
        request: CommandRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CommandResult, ForgeError>> + Send + 'a>,
    > {
        Box::pin(self.run(request))
    }
}

/// Aborts a request through its own signal, as a caller does.
pub fn cancel(cancellation: &Cancellation) {
    cancellation.cancel();
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use std::pin::Pin;
    use std::sync::Mutex;

    use super::{Pinned, identity_is_fresh, valid_login};
    use crate::transport::command::{CommandRequest, CommandResult, Runner};
    use crate::transport::error::Kind;

    #[derive(Default)]
    struct Stub {
        replies: Mutex<Vec<String>>,
        seen: Mutex<Vec<CommandRequest>>,
    }

    impl Runner for Stub {
        fn run<'a>(
            &'a self,
            request: CommandRequest,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<CommandResult, crate::transport::error::ForgeError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                self.seen.lock().expect("seen").push(request);
                let reply = self.replies.lock().expect("replies").remove(0);
                Ok(CommandResult {
                    code: Some(0),
                    stdout: format!("HTTP/2.0 200 OK\r\n\r\n{reply}"),
                    truncated: false,
                    identity_changed: false,
                    http: None,
                    unreachable: false,
                })
            })
        }
    }

    fn user(login: &str) -> String {
        format!(r#"{{"login":"{login}"}}"#)
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
    }

    fn read() -> CommandRequest {
        CommandRequest::new(
            "gh",
            vec![
                "api".to_owned(),
                "user".to_owned(),
                "--method".to_owned(),
                "GET".to_owned(),
            ],
        )
    }

    fn write() -> CommandRequest {
        CommandRequest::new(
            "gh",
            vec![
                "api".to_owned(),
                "repos/o/r/issues".to_owned(),
                "--method".to_owned(),
                "POST".to_owned(),
            ],
        )
        .with_input("{}")
    }

    #[test]
    fn a_login_is_the_shape_the_schemas_accept() {
        for login in ["octo", "octo-cat", "o1"] {
            assert!(valid_login(login), "{login}");
        }
        for login in ["", "-octo", "octo cat", "octo_cat", &"a".repeat(101)] {
            assert!(!valid_login(login), "{login}");
        }
    }

    #[test]
    fn a_verification_window_is_sixty_seconds() {
        assert!(!identity_is_fresh(None, 0.0, 60_000.0));
        assert!(identity_is_fresh(Some(1_000.0), 1_000.0, 60_000.0));
        assert!(!identity_is_fresh(Some(1_000.0), 61_000.0, 60_000.0));
        assert!(!identity_is_fresh(Some(2_000.0), 1_000.0, 60_000.0));
    }

    #[test]
    fn a_fresh_window_skips_the_probe_and_a_write_always_verifies() {
        runtime().block_on(async {
            let stub = Stub {
                replies: Mutex::new(vec![
                    user("octo"),
                    user("octo"),
                    String::from("{}"),
                    user("octo"),
                ]),
                seen: Mutex::new(Vec::new()),
            };
            let pinned = Pinned::new(
                &stub,
                "github.com",
                "octo",
                std::sync::Arc::new(|| 0.0),
                Some(0.0),
            );
            pinned.run(read()).await.expect("admitted by the window");
            assert_eq!(stub.seen.lock().expect("seen").len(), 1);
            pinned.run(write()).await.expect("a verified write");
            let seen = stub.seen.lock().expect("seen");
            assert_eq!(seen.len(), 4, "read, probe, write, post-probe");
            assert_eq!(seen[2].args, write().args);
        });
    }

    #[test]
    fn a_probe_naming_another_account_fails_closed() {
        runtime().block_on(async {
            let stub = Stub {
                replies: Mutex::new(vec![user("someone-else")]),
                seen: Mutex::new(Vec::new()),
            };
            let pinned = Pinned::new(
                &stub,
                "github.com",
                "octo",
                std::sync::Arc::new(|| 0.0),
                None,
            );
            let error = pinned.run(write()).await.expect_err("another account");
            assert_eq!(error.kind, Kind::Forbidden);
            assert_eq!(stub.seen.lock().expect("seen").len(), 1);
        });
    }

    #[test]
    fn a_write_whose_post_probe_names_another_account_reports_the_switch() {
        runtime().block_on(async {
            let stub = Stub {
                replies: Mutex::new(vec![user("octo"), String::from("{}"), user("someone-else")]),
                seen: Mutex::new(Vec::new()),
            };
            let pinned = Pinned::new(
                &stub,
                "github.com",
                "octo",
                std::sync::Arc::new(|| 0.0),
                None,
            );
            let result = pinned.run(write()).await.expect("a dispatched write");
            assert!(result.identity_changed);
        });
    }

    #[test]
    fn a_pins_predicate_skips_requests_it_does_not_pin() {
        runtime().block_on(async {
            let stub = Stub {
                replies: Mutex::new(vec![String::from("{}")]),
                seen: Mutex::new(Vec::new()),
            };
            let pinned = Pinned::new(
                &stub,
                "github.com",
                "octo",
                std::sync::Arc::new(|| 0.0),
                None,
            )
            .pins(Box::new(|request: &CommandRequest| {
                request.command == "glab"
            }));
            pinned.run(read()).await.expect("not pinned, no probe");
            assert_eq!(stub.seen.lock().expect("seen").len(), 1);
        });
    }

    #[test]
    fn a_preference_that_moves_during_a_write_marks_it_identity_changed() {
        runtime().block_on(async {
            let stub = Stub {
                replies: Mutex::new(vec![user("octo"), String::from("{}"), user("octo")]),
                seen: Mutex::new(Vec::new()),
            };
            let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let seen = calls.clone();
            let pinned = Pinned::new(
                &stub,
                "github.com",
                "octo",
                std::sync::Arc::new(|| 0.0),
                None,
            )
            .assert_current(Box::new(move || {
                // Before and after the probe the selection still holds; after the write
                // it has moved, which must be an observable effect.
                if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
                    Ok(())
                } else {
                    Err(crate::transport::error::ForgeError::new(
                        crate::transport::error::Kind::PreferencesChanged,
                    ))
                }
            }));
            let result = pinned.run(write()).await.expect("a dispatched write");
            assert!(result.identity_changed, "a moved preference is an effect");
        });
    }

    #[test]
    fn a_preference_that_moves_during_the_probe_never_dispatches_the_write() {
        runtime().block_on(async {
            let stub = Stub {
                replies: Mutex::new(vec![user("octo")]),
                seen: Mutex::new(Vec::new()),
            };
            let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let seen = calls.clone();
            let pinned = Pinned::new(
                &stub,
                "github.com",
                "octo",
                std::sync::Arc::new(|| 0.0),
                None,
            )
            .assert_current(Box::new(move || {
                // Ask 1 (before) passes; ask 2 (after the probe) sees the move.
                if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    Ok(())
                } else {
                    Err(crate::transport::error::ForgeError::new(
                        crate::transport::error::Kind::PreferencesChanged,
                    ))
                }
            }));
            let error = pinned.run(write()).await.expect_err("never dispatched");
            assert_eq!(
                error.kind,
                crate::transport::error::Kind::PreferencesChanged
            );
            assert_eq!(stub.seen.lock().expect("seen").len(), 1, "the probe only");
        });
    }

    #[test]
    fn a_non_gh_request_passes_straight_through() {
        runtime().block_on(async {
            let stub = Stub {
                replies: Mutex::new(vec![String::from("{}")]),
                seen: Mutex::new(Vec::new()),
            };
            let pinned = Pinned::new(
                &stub,
                "github.com",
                "octo",
                std::sync::Arc::new(|| 0.0),
                None,
            );
            let request = CommandRequest::new("git", vec![String::from("status")]);
            pinned.run(request).await.expect("passes through");
            assert_eq!(stub.seen.lock().expect("seen").len(), 1);
        });
    }
}
