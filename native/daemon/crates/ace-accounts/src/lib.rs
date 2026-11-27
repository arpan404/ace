// SPDX-License-Identifier: Apache-2.0
//! The person's provider accounts, ported from `@ace/accounts` and the daemon's account
//! services (ADR 0175, ADR 0002). Pure decisions live here with their ports injected: instance
//! homes and environments, quota ingestion and availability, sign-in output review, and account
//! scheduling. Nothing here stores or proxies provider credentials; an account's home is a
//! folder the provider's own CLI owns.

pub mod availability;
pub mod billing;
pub mod error;
pub mod instance;
pub mod labels;
pub mod login_output;
pub mod quota;
pub mod quota_decode;
pub mod refusal;
pub mod reset_time;
pub mod scheduler;

pub use error::AccountsError;
