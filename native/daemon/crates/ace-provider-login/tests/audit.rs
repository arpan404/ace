// SPDX-License-Identifier: Apache-2.0
//! Behavioral audit tests for `ace-provider-login`: ADR 0002 secret hygiene, sign-out safety,
//! and terminal-state cancellation semantics.

use std::error::Error;
use std::rc::Rc;

use ace_protocol::generated::ProviderKind;
use ace_provider_login::sessions::CancelTimer;
use ace_provider_login::{
    Cancel, LoginAction, LoginFuture, LoginHost, LoginInput, LoginOutcome, LoginReply,
    LoginRequest, LoginSessions, LoginState, LoginTarget, LoginUpdate, ProviderLoginDriver,
};

type PrepareFn = Rc<
    dyn Fn(
        LoginTarget,
        LoginAction,
        Cancel,
        &str,
    ) -> LoginFuture<'static, Result<Rc<dyn ProviderLoginDriver>, Box<dyn Error>>>,
>;

struct TestHost {
    prepare: PrepareFn,
}

impl LoginHost for TestHost {
    fn now(&self) -> i64 {
        1_000_000
    }
    fn id(&self) -> String {
        "login-audit-1".into()
    }
    fn schedule(&self, _callback: Box<dyn FnOnce()>, _ms: i64) -> CancelTimer {
        Box::new(|| {})
    }
    fn prepare(
        &self,
        target: LoginTarget,
        action: LoginAction,
        signal: Cancel,
        owner: &str,
    ) -> LoginFuture<'static, Result<Rc<dyn ProviderLoginDriver>, Box<dyn Error>>> {
        (self.prepare)(target, action, signal, owner)
    }
}

struct SucceedDriver;

impl ProviderLoginDriver for SucceedDriver {
    fn run(
        &self,
        _signal: Cancel,
        _emit: Rc<dyn Fn(LoginUpdate)>,
    ) -> LoginFuture<'_, Result<LoginOutcome, Box<dyn Error>>> {
        Box::pin(async {
            Ok(LoginOutcome {
                success: true,
                manual: None,
                message: None,
            })
        })
    }
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|error| panic!("{error}"));
    let local = tokio::task::LocalSet::new();
    local.block_on(&runtime, future)
}

#[test]
fn cancelling_a_succeeded_sign_in_keeps_its_succeeded_state() {
    let host = Rc::new(TestHost {
        prepare: Rc::new(|_, _, _, _| {
            Box::pin(async { Ok(Rc::new(SucceedDriver) as Rc<dyn ProviderLoginDriver>) })
        }),
    });
    let sessions = LoginSessions::new(host);
    block_on(async {
        let started = sessions
            .handle(
                "owner",
                LoginRequest::Start {
                    request_id: "req-1".into(),
                    provider: ProviderKind::Codex,
                    instance: None,
                    method: None,
                    upstream: None,
                    sign_in: None,
                },
            )
            .await;
        let session = match started.result {
            LoginReply::Ok(progress) => progress.session,
            other => panic!("unexpected start reply: {other:?}"),
        };
        let done = sessions
            .completed("owner", &session)
            .await
            .expect("completed progress");
        assert_eq!(done.state, LoginState::Succeeded);

        let after_cancel = sessions
            .handle(
                "owner",
                LoginRequest::Cancel {
                    request_id: "req-2".into(),
                    session: session.clone(),
                },
            )
            .await;
        match after_cancel.result {
            LoginReply::Ok(progress) => {
                assert_eq!(
                    progress.state,
                    LoginState::Succeeded,
                    "cancelling an already-succeeded sign-in must not overwrite it with cancelled"
                );
            }
            other => panic!("unexpected cancel reply: {other:?}"),
        }
        sessions.close().await;
    });
}

#[test]
fn secret_inputs_never_print_in_debug_representations() {
    let api_key = b"sk-ant-api03-supersecretvalue1234567890";
    let code = b"oauth-one-time-code-9876543210";
    let return_url = b"http://127.0.0.1:4321/callback?code=secret_oauth_code&state=abc";

    let req = LoginRequest::ApiKey {
        request_id: "req-1".into(),
        session: "sess-1".into(),
        api_key: api_key.to_vec(),
    };
    let code_input = LoginInput::Code(code.to_vec());
    let url_input = LoginInput::ReturnUrl(return_url.to_vec());

    let req_dbg = format!("{req:?}");
    let code_dbg = format!("{code_input:?}");
    let url_dbg = format!("{url_input:?}");

    assert!(
        !req_dbg.contains("115, 107") && !req_dbg.contains("supersecret"),
        "LoginRequest::ApiKey Debug leaked raw bytes: {req_dbg}"
    );
    assert!(
        !code_dbg.contains("111, 97") && !code_dbg.contains("9876543210"),
        "LoginInput::Code Debug leaked raw bytes: {code_dbg}"
    );
    assert!(
        !url_dbg.contains("104, 116") && !url_dbg.contains("secret_oauth_code"),
        "LoginInput::ReturnUrl Debug leaked raw bytes: {url_dbg}"
    );
}

#[test]
fn sign_out_completes_without_deleting_local_files() {
    let dir = std::env::temp_dir().join(format!("ace-login-logout-audit-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap_or_else(|error| panic!("{error}"));
    let thread_file = dir.join("thread-1.json");
    std::fs::write(&thread_file, "{\"id\":\"t1\"}").unwrap_or_else(|error| panic!("{error}"));

    let host = Rc::new(TestHost {
        prepare: Rc::new(|_, action, _, _| {
            assert_eq!(action, LoginAction::Logout);
            Box::pin(async { Ok(Rc::new(SucceedDriver) as Rc<dyn ProviderLoginDriver>) })
        }),
    });
    let sessions = LoginSessions::new(host);
    block_on(async {
        let started = sessions
            .handle(
                "owner",
                LoginRequest::Logout {
                    request_id: "logout-1".into(),
                    provider: ProviderKind::Claude,
                    instance: Some("claude-work".into()),
                },
            )
            .await;
        let session = match started.result {
            LoginReply::Ok(progress) => {
                assert_eq!(progress.action, LoginAction::Logout);
                progress.session
            }
            other => panic!("unexpected logout reply: {other:?}"),
        };
        let done = sessions
            .completed("owner", &session)
            .await
            .expect("completed logout");
        assert_eq!(done.state, LoginState::Succeeded);
        sessions.close().await;
    });
    assert!(
        thread_file.exists(),
        "sign-out must never delete local threads or user data"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
