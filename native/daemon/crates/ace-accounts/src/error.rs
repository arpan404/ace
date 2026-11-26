// SPDX-License-Identifier: Apache-2.0
//! The crate's one error type. Messages are the TypeScript's, shown to a person as they are.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AccountsError {
    #[error("ACP accounts are created with createAcpInstance or createManagedAcpInstance")]
    AcpNeedsIdentity,
    #[error("Invalid native account identity")]
    InvalidNativeIdentity,
    #[error("Implicit native CLI accounts have no isolated selectors")]
    ImplicitSelectors,
    #[error(
        "ACP identity requires the CLI's default home with no selectors, or a managed home with its profile's selectors"
    )]
    AcpIdentity,
    #[error("Conflicting instance environment")]
    ConflictingEnvironment,
    #[error("Instance home selector mismatch")]
    HomeSelectorMismatch,
    #[error("OpenCode requires data and config roots")]
    OpenCodeRoots,
    #[error("ACP account isolation is unverified for this agent")]
    AcpIsolationUnverified,
    #[error("Use the provider.login.apiKey stdin hand-off for API-key sign-in")]
    ApiKeyHandoff,
    #[error("Sign in to Cursor through the SDK browser flow")]
    CursorSignIn,
    #[error("Sign out of Cursor through the SDK auth flow")]
    CursorSignOut,
    #[error("Estimated load must be percentage points from 0 to 100")]
    EstimatedLoad,
    #[error("Instance limit exceeded")]
    InstanceLimit,
    #[error("Home depth limit exceeded")]
    HomeDepth,
    #[error("Home root does not exist")]
    HomeRoot,
}
