// SPDX-License-Identifier: Apache-2.0
//! Adapters: what each provider package exports. E1 ports each provider's
//! translator factory onto `create_translator`; E3 ports `open_session`.

use ace_core::Key;
use ace_protocol::generated::{AcpIdentity, ProviderKind};
use futures::future::LocalBoxFuture;

use crate::error::AdapterApiError;
use crate::session::{Session, SessionContext};
use crate::translator::Translator;

/// What a translator factory needs: whose thread, and its root key.
pub struct TranslatorInit {
    pub thread_id: String,
    pub root_key: Key,
    pub acp_identity: Option<AcpIdentity>,
}

/// One provider's adapter: its translator factory and its session opener.
pub trait Adapter {
    fn provider(&self) -> ProviderKind;

    /// Probe the installed CLI through provider-kit and report this version's
    /// support. E3 ports the per-provider probe.
    fn supported(&self) -> bool {
        false
    }

    fn create_translator(&self, init: TranslatorInit) -> Box<dyn Translator>;

    fn open_session(
        &self,
        ctx: SessionContext,
    ) -> LocalBoxFuture<'_, Result<Box<dyn Session>, AdapterApiError>>;
}
