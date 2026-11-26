// SPDX-License-Identifier: Apache-2.0
//! What a sign-in driver is: one prepared provider CLI (or agent) that reports progress, takes
//! input, and says whether the credential it changed is still the one ace admitted.

use std::error::Error;
use std::fmt;
use std::rc::Rc;

use futures::future::LocalBoxFuture;

use crate::Cancel;
use crate::progress::{LoginChoice, LoginManual, LoginState};

pub type LoginFuture<'a, T> = LocalBoxFuture<'a, T>;

/// What a driver reports while it runs. `state` is the state this update moves to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginUpdate {
    pub state: LoginState,
    pub url: Option<String>,
    pub user_code: Option<String>,
    pub prompt: Option<String>,
    pub choices: Option<Vec<LoginChoice>>,
    pub message: Option<String>,
    pub hint: Option<String>,
    pub manual: Option<LoginManual>,
    pub code_entry: bool,
    pub return_url_entry: bool,
}

impl LoginUpdate {
    pub fn new(state: LoginState) -> LoginUpdate {
        LoginUpdate {
            state,
            url: None,
            user_code: None,
            prompt: None,
            choices: None,
            message: None,
            hint: None,
            manual: None,
            code_entry: false,
            return_url_entry: false,
        }
    }

    pub fn url(mut self, url: impl Into<String>) -> LoginUpdate {
        self.url = Some(url.into());
        self
    }

    pub fn user_code(mut self, user_code: impl Into<String>) -> LoginUpdate {
        self.user_code = Some(user_code.into());
        self
    }

    pub fn message(mut self, message: impl Into<String>) -> LoginUpdate {
        self.message = Some(message.into());
        self
    }

    pub fn prompt(mut self, prompt: impl Into<String>) -> LoginUpdate {
        self.prompt = Some(prompt.into());
        self
    }

    pub fn hint(mut self, hint: impl Into<String>) -> LoginUpdate {
        self.hint = Some(hint.into());
        self
    }

    pub fn manual(mut self, manual: LoginManual) -> LoginUpdate {
        self.manual = Some(manual);
        self
    }

    pub fn choices(mut self, choices: Vec<LoginChoice>) -> LoginUpdate {
        self.choices = Some(choices);
        self
    }

    pub fn code_entry(mut self) -> LoginUpdate {
        self.code_entry = true;
        self
    }

    pub fn return_url_entry(mut self) -> LoginUpdate {
        self.return_url_entry = true;
        self
    }
}

/// A driver's own verdict. A success is not final until `changed` has committed it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LoginOutcome {
    pub success: bool,
    pub manual: Option<LoginManual>,
    /// ace-authored outcome detail, such as a credential that still signs the provider in.
    pub message: Option<String>,
}

/// Continuation input; API keys use [`ProviderLoginDriver::api_key`] instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginInput {
    /// A confirmation the CLI asks for (`{ confirm: true }`).
    Confirm,
    /// Enter at a prompt (`{ value: "enter" }`).
    Enter,
    /// One of the CLI's offered services or form options (`{ choice }`).
    Choice(String),
    /// A one-time code the sign-in page showed. Zeroed by the session after it is handed over.
    Code(Vec<u8>),
    /// The whole address a browser was sent back to, handed only to the agent's own listener.
    ReturnUrl(Vec<u8>),
}

/// An ace-authored failure a client may read, as opposed to a CLI diagnostic that may carry
/// credentials and only reaches the daemon's redacting log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderLoginFailure(pub String);

impl fmt::Display for ProviderLoginFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ProviderLoginFailure {}

/// One prepared sign-in. The daemon's shell implements it around a provider CLI or an agent;
/// nothing here spawns a process itself.
pub trait ProviderLoginDriver {
    /// A staged home the person must finish in a terminal ace opened.
    fn manual(&self) -> Option<LoginManual> {
        None
    }

    /// Runs until the CLI says it is done, the signal aborts, or it fails.
    fn run(
        &self,
        signal: Cancel,
        emit: Rc<dyn Fn(LoginUpdate)>,
    ) -> LoginFuture<'_, Result<LoginOutcome, Box<dyn Error>>>;

    /// Takes input for the step the driver waits on. A return address may answer asynchronously.
    fn input(&self, _input: LoginInput) -> LoginFuture<'_, bool> {
        Box::pin(async { false })
    }

    /// Hands a pasted key to the CLI's stdin. The session zeroes the bytes after this call.
    fn api_key(&self, _key: &[u8]) -> bool {
        false
    }

    /// Waits for everything the driver started to end, without taking the outcome as final.
    fn drain(&self) -> LoginFuture<'_, Result<(), Box<dyn Error>>> {
        Box::pin(async { Ok(()) })
    }

    /// Completion still belongs to the effective configuration this driver admitted. A false
    /// after cleanup turns a success into a failure, never a silent credential change.
    fn is_current(&self) -> bool {
        true
    }

    /// Commits what the CLI changed: the account's login and the models the new credential reads.
    fn changed(&self, _signal: Cancel) -> LoginFuture<'_, Result<(), Box<dyn Error>>> {
        Box::pin(async { Ok(()) })
    }

    /// Gives back the auth-change lease and the terminal.
    fn release(&self) {}
}
