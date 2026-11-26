// SPDX-License-Identifier: Apache-2.0
//! A sign-in's progress, as `@ace/protocol`'s `ProviderLoginProgress` carries it: the state a
//! client shows, the challenge it can act on, and the manual terminal a person may need.

use ace_protocol::generated::ProviderKind;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginAction {
    Login,
    Logout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginMethod {
    Login,
    ApiKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginState {
    Starting,
    AwaitingBrowser,
    AwaitingCodeEntry,
    AwaitingInput,
    AwaitingApiKey,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginChoice {
    pub id: String,
    pub label: String,
    /// Its earlier login didn't carry over to the CLI's current store: sign in again.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub note_sign_in_again: bool,
}

/// A staged home a person must finish in a terminal ace opened for them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginManual {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    pub command: String,
    pub instruction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
}

/// One sign-in's progress. Challenges live here only for the authenticated device that asked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginProgress {
    pub session: String,
    pub provider: ProviderKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    pub action: LoginAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<LoginMethod>,
    pub state: LoginState,
    pub expires_at: i64,
    pub sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<LoginChoice>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The CLI takes the code its sign-in page shows, pasted back as a code input.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub code_entry: bool,
    /// The agent waits for its browser sign-in to return to its own computer.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub return_url_entry: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual: Option<LoginManual>,
}
