// SPDX-License-Identifier: Apache-2.0
//! One sign-in per account, from admission to cleanup, from
//! `packages/accounts/src/login-sessions.ts`. Progress is emitted to listeners as it happens;
//! a request answers at once and the CLI keeps running behind it.
//!
//! The crate runs a started job with `tokio::task::spawn_local`: sign-ins belong to the daemon's
//! single thread, beside the engine, and a driver's futures never need `Send`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::error::Error;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ace_protocol::generated::ProviderKind;
use tokio::sync::Notify;

use crate::Cancel;
use crate::driver::{
    LoginFuture, LoginInput, LoginOutcome, LoginUpdate, ProviderLoginDriver, ProviderLoginFailure,
};
use crate::progress::{LoginAction, LoginManual, LoginMethod, LoginProgress, LoginState};
use crate::refusal::{LoginError, LoginResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginUpstream {
    Openai,
    Anthropic,
    Openrouter,
    Opencode,
}

/// Where a sign-in runs and what it changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginTarget {
    pub provider: ProviderKind,
    pub instance: Option<String>,
    pub method: Option<LoginMethod>,
    pub upstream: Option<LoginUpstream>,
    pub sign_in: Option<String>,
}

/// One client request. Batches and their ids are the socket layer's; this crate takes them typed.
#[derive(Clone, Debug)]
pub enum LoginRequest {
    Start {
        request_id: String,
        provider: ProviderKind,
        instance: Option<String>,
        method: Option<LoginMethod>,
        upstream: Option<LoginUpstream>,
        sign_in: Option<String>,
    },
    Logout {
        request_id: String,
        provider: ProviderKind,
        instance: Option<String>,
    },
    ApiKey {
        request_id: String,
        session: String,
        /// Zeroed as soon as the request is answered.
        api_key: Vec<u8>,
    },
    Input {
        request_id: String,
        session: String,
        input: LoginInput,
    },
    /// Cancels the job; a second cancellation retries cleanup that failed the first time.
    Cancel { request_id: String, session: String },
    /// Reads a job's progress (`provider.login.poll` and `provider.login.terminal` both do).
    Read { request_id: String, session: String },
}

impl LoginRequest {
    pub fn request_id(&self) -> &str {
        match self {
            LoginRequest::Start { request_id, .. }
            | LoginRequest::Logout { request_id, .. }
            | LoginRequest::ApiKey { request_id, .. }
            | LoginRequest::Input { request_id, .. }
            | LoginRequest::Cancel { request_id, .. }
            | LoginRequest::Read { request_id, .. } => request_id,
        }
    }
}

/// A stopped timer; dropping it or calling it cancels the callback.
pub type CancelTimer = Box<dyn Fn()>;

/// A listener of each job's progress, with the owner that started it.
pub type LoginListener = Rc<dyn Fn(&str, &LoginProgress)>;

/// What the daemon gives a sign-in: its clock, ids, timers, and the prepared driver.
pub trait LoginHost {
    fn now(&self) -> i64;
    fn id(&self) -> String;
    fn schedule(&self, callback: Box<dyn FnOnce()>, ms: i64) -> CancelTimer;
    fn prepare(
        &self,
        target: LoginTarget,
        action: LoginAction,
        signal: Cancel,
        owner: &str,
    ) -> LoginFuture<'static, Result<Rc<dyn ProviderLoginDriver>, Box<dyn Error>>>;
    /// The account a request reserves: aliases of one account share one job.
    fn instance_key(&self, _provider: ProviderKind, instance: Option<&str>) -> Option<String> {
        instance.map(str::to_string)
    }
    /// Codex device codes last 15 minutes; a session must outlive the code it shows.
    fn lifetime_ms(&self, provider: ProviderKind) -> i64 {
        if provider == ProviderKind::Codex {
            900_000
        } else {
            600_000
        }
    }
    /// A sign-in ended in `failed` because preparation or the CLI threw: the cause belongs to the
    /// daemon's redacting log, the client only sees the category.
    fn report(&self, _cause: &dyn Error, _provider: ProviderKind, _action: LoginAction) {}
}

struct Job {
    owner: String,
    key: String,
    request_id: String,
    target: LoginTarget,
    progress: LoginProgress,
    cancel: Cancel,
    expired: bool,
    done: Arc<Notify>,
    finished: Arc<AtomicBool>,
    driver: Option<Rc<dyn ProviderLoginDriver>>,
    released: bool,
    timer: Option<CancelTimer>,
}

struct Shared {
    jobs: BTreeMap<String, Rc<RefCell<Job>>>,
    active: BTreeMap<String, String>,
    listeners: BTreeMap<u64, LoginListener>,
    next_listener: u64,
    closed: bool,
}

/// One sign-in per account, its progress and its cleanup.
#[derive(Clone)]
pub struct LoginSessions {
    shared: Rc<RefCell<Shared>>,
    host: Rc<dyn LoginHost>,
}

impl LoginSessions {
    pub fn new(host: Rc<dyn LoginHost>) -> LoginSessions {
        LoginSessions {
            shared: Rc::new(RefCell::new(Shared {
                jobs: BTreeMap::new(),
                active: BTreeMap::new(),
                listeners: BTreeMap::new(),
                next_listener: 0,
                closed: false,
            })),
            host,
        }
    }

    /// Hears every job's progress, whichever device owns it.
    pub fn listen(&self, listener: LoginListener) -> u64 {
        let mut shared = self.shared.borrow_mut();
        let id = shared.next_listener;
        shared.next_listener += 1;
        shared.listeners.insert(id, listener);
        id
    }

    pub fn unlisten(&self, id: u64) {
        self.shared.borrow_mut().listeners.remove(&id);
    }

    /// Whether a sign-in already holds this account.
    pub fn busy(&self, provider: ProviderKind, instance: Option<&str>) -> bool {
        let key = self.key(provider, instance);
        self.shared.borrow().active.contains_key(&key)
    }

    fn key(&self, provider: ProviderKind, instance: Option<&str>) -> String {
        if let Some(key) = self.host.instance_key(provider, instance) {
            return format!("{provider}:{key}");
        }
        match instance {
            Some(instance) if instance != format!("{provider}-cli-default").as_str() => {
                format!("{provider}:{instance}")
            }
            _ => format!("{provider}:default"),
        }
    }

    pub async fn handle(&self, owner: &str, request: LoginRequest) -> LoginResult {
        match request {
            LoginRequest::Start {
                request_id,
                provider,
                instance,
                method,
                upstream,
                sign_in,
            } => {
                // A choice of sign-in method is Antigravity's alone.
                if sign_in.is_some()
                    && (provider != ProviderKind::Antigravity
                        || method == Some(LoginMethod::ApiKey))
                {
                    return LoginResult::err(&request_id, LoginError::InvalidInput);
                }
                let target = LoginTarget {
                    provider,
                    instance: instance.clone(),
                    method,
                    upstream,
                    sign_in,
                };
                self.start(owner, &request_id, target, LoginAction::Login, method)
            }
            LoginRequest::Logout {
                request_id,
                provider,
                instance,
            } => {
                let target = LoginTarget {
                    provider,
                    instance,
                    method: None,
                    upstream: None,
                    sign_in: None,
                };
                self.start(owner, &request_id, target, LoginAction::Logout, None)
            }
            LoginRequest::ApiKey {
                request_id,
                session,
                mut api_key,
            } => {
                let answer = self
                    .take_api_key(owner, &request_id, &session, &api_key)
                    .await;
                api_key.fill(0);
                answer
            }
            LoginRequest::Input {
                request_id,
                session,
                input,
            } => self.take_input(owner, &request_id, &session, input).await,
            LoginRequest::Cancel {
                request_id,
                session,
            } => self.cancel(owner, &request_id, &session).await,
            LoginRequest::Read {
                request_id,
                session,
            } => {
                let job = self.shared.borrow().jobs.get(&session).cloned();
                match job {
                    None => LoginResult::err(&request_id, LoginError::NotFound),
                    Some(job) if job.borrow().owner != owner => {
                        LoginResult::err(&request_id, LoginError::Forbidden)
                    }
                    Some(job) => LoginResult::ok(&request_id, job.borrow().progress.clone()),
                }
            }
        }
    }

    fn start(
        &self,
        owner: &str,
        request_id: &str,
        target: LoginTarget,
        action: LoginAction,
        method: Option<LoginMethod>,
    ) -> LoginResult {
        let key = self.key(target.provider, target.instance.as_deref());
        let mut shared = self.shared.borrow_mut();
        if shared.closed {
            return crate::refusal::unavailable_login(
                request_id,
                crate::refusal::LoginUnavailableReason::Stopping,
            );
        }
        let retried = shared.jobs.values().find(|job| {
            let job = job.borrow();
            job.owner == owner && job.key == key && job.request_id == request_id
        });
        if let Some(job) = retried {
            let progress = job.borrow().progress.clone();
            return LoginResult::ok(request_id, progress);
        }
        if shared.active.contains_key(&key) {
            return LoginResult::err(request_id, LoginError::Busy);
        }
        if shared.jobs.len() >= 32 {
            return LoginResult::err(request_id, LoginError::Busy);
        }
        let session = self.host.id();
        let lifetime = self.host.lifetime_ms(target.provider);
        let progress = LoginProgress {
            session: session.clone(),
            provider: target.provider,
            instance: target.instance.clone(),
            action,
            method: if action == LoginAction::Login {
                Some(method.unwrap_or(LoginMethod::Login))
            } else {
                None
            },
            state: LoginState::Starting,
            expires_at: self.host.now() + lifetime,
            sequence: 0,
            url: None,
            user_code: None,
            prompt: None,
            choices: None,
            message: None,
            code_entry: false,
            return_url_entry: false,
            hint: None,
            manual: None,
        };
        let job = Rc::new(RefCell::new(Job {
            owner: owner.to_string(),
            key: key.clone(),
            request_id: request_id.to_string(),
            target,
            progress,
            cancel: Cancel::default(),
            expired: false,
            done: Arc::new(Notify::new()),
            finished: Arc::new(AtomicBool::new(false)),
            driver: None,
            released: false,
            timer: None,
        }));
        shared.jobs.insert(session.clone(), job.clone());
        shared.active.insert(key, session.clone());
        let progress = job.borrow().progress.clone();
        drop(shared);
        self.arm_expiry(&job, &session, lifetime);
        let sessions = self.clone();
        let running = session.clone();
        tokio::task::spawn_local(async move { sessions.run(&running).await });
        LoginResult::ok(request_id, progress)
    }

    fn arm_expiry(&self, job: &Rc<RefCell<Job>>, session: &str, lifetime: i64) {
        let sessions = self.clone();
        let armed = job.clone();
        let running = session.to_string();
        let timer = self.host.schedule(
            Box::new(move || {
                armed.borrow_mut().expired = true;
                armed.borrow().cancel.abort();
                let sessions = sessions.clone();
                let waiting = armed.clone();
                let running = running.clone();
                tokio::task::spawn_local(async move {
                    sessions.await_done(&waiting).await;
                    sessions.schedule_deletion(&running, 60_000);
                });
            }),
            lifetime,
        );
        job.borrow_mut().timer = Some(timer);
    }

    fn schedule_deletion(&self, session: &str, ms: i64) {
        let shared = self.shared.clone();
        let running = session.to_string();
        let timer = self.host.schedule(
            Box::new(move || {
                shared.borrow_mut().jobs.remove(&running);
            }),
            ms,
        );
        if let Some(job) = self.shared.borrow().jobs.get(session) {
            job.borrow_mut().timer = Some(timer);
        }
    }

    async fn await_done(&self, job: &Rc<RefCell<Job>>) {
        let (done, finished) = {
            let job = job.borrow();
            (job.done.clone(), job.finished.clone())
        };
        while !finished.load(Ordering::SeqCst) {
            done.notified().await;
        }
    }

    fn finish(&self, job: &Rc<RefCell<Job>>) {
        job.borrow().finished.store(true, Ordering::SeqCst);
        job.borrow().done.notify_waiters();
    }

    async fn run(&self, session: &str) {
        let job = match self.shared.borrow().jobs.get(session) {
            Some(job) => job.clone(),
            None => return,
        };
        let (target, action, signal, owner) = {
            let job = job.borrow();
            (
                job.target.clone(),
                job.progress.action,
                job.cancel.clone(),
                job.owner.clone(),
            )
        };
        let provider = target.provider;
        let mut success = false;
        let mut manual: Option<LoginManual> = None;
        let mut failure: Option<String> = None;
        let mut outcome_message: Option<String> = None;
        let prepared = self
            .host
            .prepare(target, action, signal.clone(), &owner)
            .await;
        let driver = match prepared {
            Err(error) => {
                failure = client_message(error.as_ref());
                if !signal.is_aborted() {
                    self.host.report(&*error, provider, action);
                }
                None
            }
            Ok(driver) => {
                job.borrow_mut().driver = Some(driver.clone());
                manual = driver.manual();
                Some(driver)
            }
        };
        if let Some(driver) = driver.as_ref().filter(|_| !signal.is_aborted()) {
            {
                let sessions = self.clone();
                let running = session.to_string();
                let emit: Rc<dyn Fn(LoginUpdate)> =
                    Rc::new(move |update| sessions.emit(&running, update));
                match driver.run(signal.clone(), emit).await {
                    Ok(outcome) => {
                        manual = outcome.manual.or(manual);
                        outcome_message = outcome.message;
                        success = outcome.success;
                    }
                    Err(error) => {
                        failure = client_message(error.as_ref());
                        if !signal.is_aborted() {
                            self.host.report(&*error, provider, action);
                        }
                    }
                }
            }
        }
        if let Some(driver) = driver.as_ref().filter(|_| success && !signal.is_aborted()) {
            {
                self.emit(session, LoginUpdate::new(LoginState::Verifying));
                if let Err(error) = driver.changed(signal.clone()).await {
                    success = false;
                    failure = client_message(error.as_ref());
                    if !signal.is_aborted() {
                        self.host.report(&*error, provider, action);
                    }
                }
            }
        }
        // Cleanup is the last word: a CLI that will not end cannot be reported successful, and
        // the account stays reserved until a retried cancellation drains it.
        if let Some(driver) = &driver {
            if driver.drain().await.is_err() {
                self.emit(
                    session,
                    LoginUpdate::new(LoginState::Verifying).message(
                        "CLI cleanup needs attention. Retry cancellation before starting another login.",
                    ),
                );
                self.finish(&job);
                return;
            }
            if success && !driver.is_current() {
                success = false;
                if driver.drain().await.is_err() {
                    self.emit(
                        session,
                        LoginUpdate::new(LoginState::Verifying).message(
                            "CLI cleanup needs attention. Retry cancellation before starting another login.",
                        ),
                    );
                    self.finish(&job);
                    return;
                }
            }
            driver.release();
            job.borrow_mut().released = true;
        }
        let (expired, cancelled) = {
            let mut job = job.borrow_mut();
            job.timer = None;
            (job.expired, job.cancel.is_aborted())
        };
        let state = if cancelled {
            if expired {
                LoginState::Failed
            } else {
                LoginState::Cancelled
            }
        } else if success {
            LoginState::Succeeded
        } else {
            LoginState::Failed
        };
        self.release_active(session);
        let message =
            if success {
                outcome_message
            } else {
                Some(failure.or(outcome_message).unwrap_or_else(|| {
                    "Provider authentication could not be completed.".to_string()
                }))
            };
        let mut update = LoginUpdate::new(state);
        if let Some(staged) = manual.clone().filter(|_| !success) {
            update = update
                .manual(staged.clone())
                .hint(staged.instruction.clone());
        }
        if expired {
            update = update.message("Sign-in timed out. Try again.");
            if let Some(manual) = manual {
                update = update.manual(manual.clone()).hint(manual.instruction);
            }
        } else if cancelled {
            update = update.message("Sign-in cancelled.");
        } else if let Some(message) = message {
            update = update.message(message);
        }
        self.emit(session, update);
        self.finish(&job);
    }

    fn release_active(&self, session: &str) {
        let mut shared = self.shared.borrow_mut();
        let key = shared.jobs.get(session).map(|job| job.borrow().key.clone());
        if let Some(key) =
            key.filter(|key| shared.active.get(key).map(String::as_str) == Some(session))
        {
            shared.active.remove(&key);
        }
    }

    async fn take_api_key(
        &self,
        owner: &str,
        request_id: &str,
        session: &str,
        key: &[u8],
    ) -> LoginResult {
        let job = match self.owned(owner, request_id, session) {
            Ok(job) => job,
            Err(answer) => return answer,
        };
        let (awaiting, driver) = {
            let job = job.borrow();
            (
                job.progress.state == LoginState::AwaitingApiKey,
                job.driver.clone(),
            )
        };
        let accepted = awaiting && driver.is_some_and(|driver| driver.api_key(key));
        if !accepted {
            return LoginResult::err(request_id, LoginError::InvalidInput);
        }
        let progress = job.borrow().progress.clone();
        LoginResult::ok(request_id, progress)
    }

    async fn take_input(
        &self,
        owner: &str,
        request_id: &str,
        session: &str,
        input: LoginInput,
    ) -> LoginResult {
        let job = match self.owned(owner, request_id, session) {
            Ok(job) => job,
            Err(answer) => return answer,
        };
        let (expected, driver) = {
            let job = job.borrow();
            let expected = match &input {
                LoginInput::Code(_) => job.progress.code_entry,
                LoginInput::ReturnUrl(_) => {
                    job.progress.state == LoginState::AwaitingBrowser
                        && job.progress.return_url_entry
                        && self
                            .shared
                            .borrow()
                            .active
                            .get(&job.key)
                            .map(String::as_str)
                            == Some(session)
                }
                _ => job.progress.state == LoginState::AwaitingInput,
            };
            (expected, job.driver.clone())
        };
        let taken = match (expected, driver) {
            (true, Some(driver)) => driver.input(input).await,
            _ => false,
        };
        if !taken {
            return LoginResult::err(request_id, LoginError::InvalidInput);
        }
        let progress = job.borrow().progress.clone();
        LoginResult::ok(request_id, progress)
    }

    fn owned(
        &self,
        owner: &str,
        request_id: &str,
        session: &str,
    ) -> Result<Rc<RefCell<Job>>, LoginResult> {
        let job = self.shared.borrow().jobs.get(session).cloned();
        match job {
            None => Err(LoginResult::err(request_id, LoginError::NotFound)),
            Some(job) if job.borrow().owner != owner => {
                Err(LoginResult::err(request_id, LoginError::Forbidden))
            }
            Some(job) => Ok(job),
        }
    }

    async fn cancel(&self, owner: &str, request_id: &str, session: &str) -> LoginResult {
        let job = match self.owned(owner, request_id, session) {
            Ok(job) => job,
            Err(answer) => return answer,
        };
        let active = {
            let job = job.borrow();
            self.shared
                .borrow()
                .active
                .get(&job.key)
                .map(String::as_str)
                == Some(session)
        };
        if active {
            job.borrow().cancel.abort();
            self.await_done(&job).await;
            let (driver, released) = {
                let job = job.borrow();
                (job.driver.clone(), job.released)
            };
            if let Some(driver) = driver {
                if driver.drain().await.is_err() {
                    return LoginResult::err(request_id, LoginError::Busy);
                }
                if !released {
                    driver.release();
                    job.borrow_mut().released = true;
                }
            }
            self.release_active(session);
            self.emit(
                session,
                LoginUpdate::new(LoginState::Cancelled).message("Sign-in cancelled."),
            );
            if job.borrow().expired {
                self.schedule_deletion(session, 60_000);
            }
        } else {
            self.emit(
                session,
                LoginUpdate::new(LoginState::Cancelled).message("Sign-in cancelled."),
            );
        }
        let progress = job.borrow().progress.clone();
        LoginResult::ok(request_id, progress)
    }

    /// Waits for a job to end, then answers its last progress.
    pub async fn completed(&self, owner: &str, session: &str) -> Option<LoginProgress> {
        let job = self.shared.borrow().jobs.get(session).cloned()?;
        if job.borrow().owner != owner {
            return None;
        }
        self.await_done(&job).await;
        Some(job.borrow().progress.clone())
    }

    pub async fn close(&self) {
        let jobs: Vec<Rc<RefCell<Job>>> = {
            let mut shared = self.shared.borrow_mut();
            shared.closed = true;
            let jobs: Vec<_> = shared.jobs.values().cloned().collect();
            shared.listeners.clear();
            jobs
        };
        for job in &jobs {
            if let Some(timer) = job.borrow_mut().timer.take() {
                timer();
            }
            job.borrow().cancel.abort();
        }
        for job in &jobs {
            self.await_done(job).await;
            let (driver, released) = {
                let job = job.borrow();
                (job.driver.clone(), job.released)
            };
            if let (Some(driver), false) = (driver, released) {
                let _ = driver.drain().await;
                driver.release();
                job.borrow_mut().released = true;
            }
        }
        let mut shared = self.shared.borrow_mut();
        shared.active.clear();
        shared.jobs.clear();
    }

    /// Never panics on a failing listener: it runs from a driver's progress callback.
    fn emit(&self, session: &str, update: LoginUpdate) {
        let (owner, progress, listeners) = {
            let shared = self.shared.borrow();
            let Some(job) = shared.jobs.get(session) else {
                return;
            };
            let mut job = job.borrow_mut();
            let sequence = job.progress.sequence + 1;
            let mut next = job.progress.clone();
            next.state = update.state;
            next.sequence = sequence;
            next.url = update.url.or(next.url);
            next.user_code = update.user_code.or(next.user_code);
            next.prompt = update
                .prompt
                .map(|prompt| crate::clip(&prompt))
                .or(next.prompt);
            next.choices = update.choices.or(next.choices);
            next.message = update
                .message
                .map(|message| crate::clip(&message))
                .or(next.message);
            next.hint = update.hint.or(next.hint);
            next.manual = update.manual.or(next.manual);
            next.code_entry = update.code_entry || next.code_entry;
            next.return_url_entry = update.return_url_entry || next.return_url_entry;
            job.progress = next.clone();
            (
                job.owner.clone(),
                next,
                shared.listeners.values().cloned().collect::<Vec<_>>(),
            )
        };
        for listener in listeners {
            listener(&owner, &progress);
        }
    }
}

fn client_message(error: &(dyn Error + 'static)) -> Option<String> {
    error
        .downcast_ref::<ProviderLoginFailure>()
        .map(|failure| failure.0.clone())
}

/// What a driver's result says, for the final message.
pub fn outcome_message(outcome: &LoginOutcome) -> Option<String> {
    outcome.message.clone()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::future::Future;
    use std::rc::Rc;

    use futures::channel::oneshot;

    use super::*;
    use crate::LoginProgress;
    use crate::refusal::LoginReply;

    type Prepare = Rc<
        dyn Fn(
            LoginTarget,
            LoginAction,
            Cancel,
            String,
        )
            -> LoginFuture<'static, Result<Rc<dyn ProviderLoginDriver>, Box<dyn Error>>>,
    >;
    type Scheduled = Rc<RefCell<Vec<(Box<dyn FnOnce()>, i64)>>>;

    struct FakeHost {
        prepare: Prepare,
        scheduled: Scheduled,
        reported: Rc<RefCell<Vec<String>>>,
        ids: Cell<u64>,
        now: Cell<i64>,
        instance_key: Option<String>,
    }

    impl LoginHost for FakeHost {
        fn now(&self) -> i64 {
            self.now.get()
        }
        fn id(&self) -> String {
            let id = self.ids.get() + 1;
            self.ids.set(id);
            format!("login-{id}")
        }
        fn schedule(&self, callback: Box<dyn FnOnce()>, ms: i64) -> CancelTimer {
            self.scheduled.borrow_mut().push((callback, ms));
            Box::new(|| {})
        }
        fn prepare(
            &self,
            target: LoginTarget,
            action: LoginAction,
            signal: Cancel,
            owner: &str,
        ) -> LoginFuture<'static, Result<Rc<dyn ProviderLoginDriver>, Box<dyn Error>>> {
            (self.prepare)(target, action, signal, owner.to_string())
        }
        fn instance_key(&self, _provider: ProviderKind, _instance: Option<&str>) -> Option<String> {
            self.instance_key.clone()
        }
        fn report(&self, cause: &dyn Error, _provider: ProviderKind, _action: LoginAction) {
            self.reported.borrow_mut().push(cause.to_string());
        }
    }

    fn host(prepare: Prepare, instance_key: Option<String>) -> Rc<FakeHost> {
        Rc::new(FakeHost {
            prepare,
            scheduled: Rc::new(RefCell::new(Vec::new())),
            reported: Rc::new(RefCell::new(Vec::new())),
            ids: Cell::new(0),
            now: Cell::new(1000),
            instance_key,
        })
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => panic!("runtime: {error}"),
        };
        let local = tokio::task::LocalSet::new();
        local.block_on(&runtime, future)
    }

    async fn wait_until<R>(receiver: oneshot::Receiver<R>) -> R {
        match receiver.await {
            Ok(value) => value,
            Err(error) => panic!("channel: {error}"),
        }
    }

    fn start(request_id: &str, provider: ProviderKind) -> LoginRequest {
        LoginRequest::Start {
            request_id: request_id.to_string(),
            provider,
            instance: None,
            method: None,
            upstream: None,
            sign_in: None,
        }
    }

    fn progress_of(result: &LoginResult) -> &LoginProgress {
        match &result.result {
            LoginReply::Ok(progress) => progress,
            other => panic!("expected progress, got {other:?}"),
        }
    }

    /// A driver that succeeds, commits, and waits in its final drain while the test decides
    /// whether it is still the admitted credential.
    struct FreshDriver {
        fresh: Rc<Cell<bool>>,
        changed: Rc<Cell<bool>>,
        entered: RefCell<Option<oneshot::Sender<()>>>,
        release: RefCell<Option<oneshot::Receiver<()>>>,
    }

    impl ProviderLoginDriver for FreshDriver {
        fn run(
            &self,
            _signal: Cancel,
            _emit: Rc<dyn Fn(LoginUpdate)>,
        ) -> LoginFuture<'_, Result<LoginOutcome, Box<dyn Error>>> {
            Box::pin(async {
                Ok(LoginOutcome {
                    success: true,
                    ..Default::default()
                })
            })
        }

        fn changed(&self, _signal: Cancel) -> LoginFuture<'_, Result<(), Box<dyn Error>>> {
            self.changed.set(true);
            Box::pin(async { Ok(()) })
        }

        fn drain(&self) -> LoginFuture<'_, Result<(), Box<dyn Error>>> {
            let changed = self.changed.get();
            let entered = self.entered.borrow_mut().take();
            let release = self.release.borrow_mut().take();
            Box::pin(async move {
                if changed {
                    if let Some(entered) = entered {
                        let _ = entered.send(());
                    }
                    if let Some(release) = release {
                        let _ = release.await;
                    }
                }
                Ok(())
            })
        }

        fn is_current(&self) -> bool {
            self.fresh.get()
        }
    }

    // packages/accounts/src/login-sessions.test.ts
    // "login success respects admission freshness %s after final cleanup"
    #[test]
    fn login_success_respects_admission_freshness_after_final_cleanup() {
        for unchanged in [true, false] {
            let fresh = Rc::new(Cell::new(true));
            let changed = Rc::new(Cell::new(false));
            let (entered_tx, entered_rx) = oneshot::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let driver = Rc::new(FreshDriver {
                fresh: fresh.clone(),
                changed: changed.clone(),
                entered: RefCell::new(Some(entered_tx)),
                release: RefCell::new(Some(release_rx)),
            });
            let for_prepare = driver.clone();
            let host = host(
                Rc::new(move |_target, _action, _signal, _owner| {
                    let driver = for_prepare.clone();
                    Box::pin(async move { Ok(driver as Rc<dyn ProviderLoginDriver>) })
                }),
                None,
            );
            let sessions = LoginSessions::new(host);
            let (state, busy) = block_on(async {
                sessions
                    .handle("owner", start("start", ProviderKind::Codex))
                    .await;
                wait_until(entered_rx).await;
                fresh.set(unchanged);
                let _ = release_tx.send(());
                let done = sessions.completed("owner", "login-1").await;
                let busy = sessions.busy(ProviderKind::Codex, None);
                (done.map(|progress| progress.state), busy)
            });
            assert!(changed.get());
            assert_eq!(
                state,
                Some(if unchanged {
                    LoginState::Succeeded
                } else {
                    LoginState::Failed
                })
            );
            assert!(!busy);
            block_on(sessions.close());
        }
    }

    // "a CLI whose cleanup failed cannot be reported successful or replaced until cancellation drains it"
    #[test]
    fn a_cli_whose_cleanup_failed_cannot_be_reported_successful_or_replaced() {
        let can_drain = Rc::new(Cell::new(false));
        let for_prepare = can_drain.clone();
        let host = host(
            Rc::new(move |_target, _action, _signal, _owner| {
                struct Draining {
                    can_drain: Rc<Cell<bool>>,
                }
                impl ProviderLoginDriver for Draining {
                    fn run(
                        &self,
                        _signal: Cancel,
                        _emit: Rc<dyn Fn(LoginUpdate)>,
                    ) -> LoginFuture<'_, Result<LoginOutcome, Box<dyn Error>>> {
                        Box::pin(async {
                            Ok(LoginOutcome {
                                success: true,
                                ..Default::default()
                            })
                        })
                    }
                    fn drain(&self) -> LoginFuture<'_, Result<(), Box<dyn Error>>> {
                        let can_drain = self.can_drain.clone();
                        Box::pin(async move {
                            if can_drain.get() {
                                Ok(())
                            } else {
                                Err("Unverified process exit".into())
                            }
                        })
                    }
                }
                let can_drain = for_prepare.clone();
                Box::pin(async move {
                    Ok(Rc::new(Draining { can_drain }) as Rc<dyn ProviderLoginDriver>)
                })
            }),
            None,
        );
        let sessions = LoginSessions::new(host.clone());
        let events = Rc::new(RefCell::new(Vec::<LoginState>::new()));
        sessions.listen({
            let events = events.clone();
            Rc::new(move |_owner, progress| events.borrow_mut().push(progress.state))
        });
        block_on(async {
            sessions
                .handle("phone", start("start", ProviderKind::Codex))
                .await;
            let replacement = sessions
                .handle("phone", start("replacement", ProviderKind::Codex))
                .await;
            assert!(matches!(
                replacement.result,
                LoginReply::Err(LoginError::Busy)
            ));
            let busy_cancel = sessions
                .handle(
                    "phone",
                    LoginRequest::Cancel {
                        request_id: "cancel".into(),
                        session: "login-1".into(),
                    },
                )
                .await;
            assert!(matches!(
                busy_cancel.result,
                LoginReply::Err(LoginError::Busy)
            ));
            can_drain.set(true);
            let cancelled = sessions
                .handle(
                    "phone",
                    LoginRequest::Cancel {
                        request_id: "retry".into(),
                        session: "login-1".into(),
                    },
                )
                .await;
            assert_eq!(progress_of(&cancelled).state, LoginState::Cancelled);
            let started = sessions
                .handle("phone", start("replacement", ProviderKind::Codex))
                .await;
            assert_eq!(progress_of(&started).session, "login-2");
            sessions.close().await;
        });
        assert!(!events.borrow().contains(&LoginState::Succeeded));
        assert!(host.reported.borrow().is_empty());
    }

    // "provider-instance aliases share one reservation and cancellation waits for preparation"
    #[test]
    fn provider_instance_aliases_share_one_reservation_and_cancellation_waits_for_preparation() {
        let admitted = Rc::new(RefCell::new(None::<oneshot::Sender<()>>));
        let (prepared_tx, prepared_rx) = oneshot::channel();
        let prepared = Rc::new(RefCell::new(Some(prepared_rx)));
        let host = host(
            {
                let admitted = admitted.clone();
                Rc::new(move |_target, _action, _signal, _owner| {
                    let admitted = admitted.borrow_mut().take();
                    let prepared = prepared.borrow_mut().take();
                    Box::pin(async move {
                        if let Some(admitted) = admitted {
                            let _ = admitted.send(());
                        }
                        if let Some(prepared) = prepared {
                            let _ = prepared.await;
                        }
                        struct Silent;
                        impl ProviderLoginDriver for Silent {
                            fn run(
                                &self,
                                _signal: Cancel,
                                _emit: Rc<dyn Fn(LoginUpdate)>,
                            ) -> LoginFuture<'_, Result<LoginOutcome, Box<dyn Error>>>
                            {
                                Box::pin(async { Ok(LoginOutcome::default()) })
                            }
                        }
                        Ok(Rc::new(Silent) as Rc<dyn ProviderLoginDriver>)
                    })
                })
            },
            Some("selected-sdk".into()),
        );
        let sessions = LoginSessions::new(host);
        let block = block_on(async {
            let (admitted_tx, admitted_rx) = oneshot::channel();
            *admitted.borrow_mut() = Some(admitted_tx);
            let mut first = start("start", ProviderKind::Cursor);
            if let LoginRequest::Start { instance, .. } = &mut first {
                *instance = Some("one".into());
            }
            let mut alias = start("alias", ProviderKind::Cursor);
            if let LoginRequest::Start { instance, .. } = &mut alias {
                *instance = Some("two".into());
            }
            sessions.handle("phone", first).await;
            let entered = admitted_rx;
            let alias_busy = sessions.handle("phone", alias).await;
            let cancel = sessions.handle(
                "phone",
                LoginRequest::Cancel {
                    request_id: "cancel".into(),
                    session: "login-1".into(),
                },
            );
            let _ = prepared_tx.send(());
            let (cancel, _) = futures::future::join(cancel, entered).await;
            (alias_busy, cancel)
        });
        let (alias_busy, cancelled) = block;
        assert!(matches!(
            alias_busy.result,
            LoginReply::Err(LoginError::Busy)
        ));
        assert_eq!(progress_of(&cancelled).state, LoginState::Cancelled);
        block_on(sessions.close());
    }

    // "a sign-in that throws while preparing ends failed, with its cause reported for the log, not the client"
    #[test]
    fn a_sign_in_that_throws_while_preparing_ends_failed_with_its_cause_reported() {
        let host = host(
            Rc::new(|_target, _action, _signal, _owner| {
                Box::pin(async {
                    Err(Box::new(std::io::Error::other("secret diagnostic")) as Box<dyn Error>)
                })
            }),
            None,
        );
        let sessions = LoginSessions::new(host.clone());
        let progress = block_on(async {
            sessions
                .handle("owner", start("start", ProviderKind::Codex))
                .await;
            sessions.completed("owner", "login-1").await
        });
        let progress = match progress {
            Some(progress) => progress,
            None => panic!("missing progress"),
        };
        assert_eq!(progress.state, LoginState::Failed);
        assert_eq!(
            progress.message.as_deref(),
            Some("Provider authentication could not be completed.")
        );
        assert!(
            host.reported
                .borrow()
                .iter()
                .any(|cause| cause.contains("secret diagnostic"))
        );
        block_on(sessions.close());
    }

    // "provider exception text never reaches the sign-out result"
    #[test]
    fn provider_exception_text_never_reaches_the_sign_out_result() {
        let host = host(
            Rc::new(|_target, _action, _signal, _owner| {
                Box::pin(async {
                    struct Failing;
                    impl ProviderLoginDriver for Failing {
                        fn run(
                            &self,
                            _signal: Cancel,
                            _emit: Rc<dyn Fn(LoginUpdate)>,
                        ) -> LoginFuture<'_, Result<LoginOutcome, Box<dyn Error>>>
                        {
                            Box::pin(async {
                                Err(Box::new(std::io::Error::other("private token 1234"))
                                    as Box<dyn Error>)
                            })
                        }
                    }
                    Ok(Rc::new(Failing) as Rc<dyn ProviderLoginDriver>)
                })
            }),
            None,
        );
        let sessions = LoginSessions::new(host);
        let progress = block_on(async {
            sessions
                .handle("owner", start("logout", ProviderKind::Cursor))
                .await;
            sessions.completed("owner", "login-1").await
        });
        let progress = match progress {
            Some(progress) => progress,
            None => panic!("missing progress"),
        };
        assert_eq!(progress.state, LoginState::Failed);
        let message = progress.message.unwrap_or_default();
        assert!(!message.contains("private token"));
        assert_eq!(message, "Provider authentication could not be completed.");
        block_on(sessions.close());
    }

    // "a CLI that ends with a message longer than the wire allows still ends the sign-in as failed"
    #[test]
    fn a_long_failure_message_still_ends_the_sign_in() {
        let host = host(
            Rc::new(|_target, _action, _signal, _owner| {
                Box::pin(async {
                    struct Wordy;
                    impl ProviderLoginDriver for Wordy {
                        fn run(
                            &self,
                            _signal: Cancel,
                            _emit: Rc<dyn Fn(LoginUpdate)>,
                        ) -> LoginFuture<'_, Result<LoginOutcome, Box<dyn Error>>>
                        {
                            Box::pin(async {
                                Err(Box::new(ProviderLoginFailure("x".repeat(4_000)))
                                    as Box<dyn Error>)
                            })
                        }
                    }
                    Ok(Rc::new(Wordy) as Rc<dyn ProviderLoginDriver>)
                })
            }),
            None,
        );
        let sessions = LoginSessions::new(host);
        let progress = block_on(async {
            sessions
                .handle("owner", start("start", ProviderKind::Codex))
                .await;
            sessions.completed("owner", "login-1").await
        });
        let progress = match progress {
            Some(progress) => progress,
            None => panic!("missing progress"),
        };
        assert_eq!(progress.state, LoginState::Failed);
        let message = progress.message.unwrap_or_default();
        assert_eq!(message.chars().count(), 256);
        assert!(message.ends_with('…'));
        block_on(sessions.close());
    }

    // apps/daemon/src/provider-login.server.process.test.ts
    // "progress and choices serialize with the protocol's literals, and never carry a secret"
    #[test]
    fn progress_and_choices_serialize_with_the_protocols_literals() {
        assert_eq!(
            serde_json::to_value(LoginState::AwaitingCodeEntry).unwrap_or_default(),
            serde_json::json!("awaiting_code_entry")
        );
        assert_eq!(
            serde_json::to_value(LoginAction::Logout).unwrap_or_default(),
            serde_json::json!("logout")
        );
        assert_eq!(
            serde_json::to_value(LoginMethod::ApiKey).unwrap_or_default(),
            serde_json::json!("api_key")
        );
        let choice = crate::LoginChoice {
            id: "github-copilot".into(),
            label: "GitHub Copilot".into(),
            note_sign_in_again: true,
        };
        let value = serde_json::to_value(&choice).unwrap_or_default();
        assert_eq!(value["note"], "sign_in_again");
        let fresh = crate::LoginChoice {
            note_sign_in_again: false,
            ..choice
        };
        assert!(
            serde_json::to_value(&fresh)
                .unwrap_or_default()
                .get("note")
                .is_none()
        );
        let manual = crate::LoginManual::open_terminal("opencode auth login", "Finish there.");
        assert_eq!(
            serde_json::to_value(&manual).unwrap_or_default()["action"],
            "open_terminal"
        );
        let progress = LoginProgress {
            session: "login-1".into(),
            provider: ProviderKind::Codex,
            instance: None,
            action: LoginAction::Login,
            method: Some(LoginMethod::Login),
            state: LoginState::AwaitingBrowser,
            expires_at: 1_900_000,
            sequence: 3,
            url: Some("https://auth.example.test/device".into()),
            user_code: Some("ABCD-2048".into()),
            prompt: None,
            choices: None,
            message: None,
            code_entry: true,
            return_url_entry: true,
            hint: None,
            manual: Some(manual),
        };
        let value = serde_json::to_value(&progress).unwrap_or_default();
        assert_eq!(value["expiresAt"], 1_900_000);
        assert_eq!(value["userCode"], "ABCD-2048");
        assert_eq!(value["codeEntry"], true);
        assert_eq!(value["returnUrlEntry"], true);
        assert_eq!(value["manual"]["action"], "open_terminal");
        assert!(value.get("instance").is_none());
        assert!(value.get("prompt").is_none());
        // The provider is the generated protocol's own kind.
        assert_eq!(
            serde_json::from_value::<ProviderKind>(value["provider"].clone()).ok(),
            Some(ProviderKind::Codex)
        );
    }

    // "a daemon shutting down refuses a new sign-in as stopping"
    #[test]
    fn a_daemon_shutting_down_refuses_a_new_sign_in_as_stopping() {
        let host = host(
            Rc::new(|_target, _action, _signal, _owner| {
                Box::pin(async { panic!("prepared while stopping") })
            }),
            None,
        );
        let sessions = LoginSessions::new(host);
        block_on(sessions.close());
        let refused = block_on(sessions.handle("owner", start("start", ProviderKind::Codex)));
        assert_eq!(
            refused.result,
            LoginReply::Unavailable(crate::LoginUnavailableReason::Stopping)
        );
    }
}
