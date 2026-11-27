// SPDX-License-Identifier: Apache-2.0
//! The provider account a catalog row came from.
//!
//! The catalog's slice of `packages/models/src/types.ts`'s `ModelInstance` (loginRevision,
//! profileRevision and the probe settings belong to discovery, not row shaping). `cwd` is
//! here because OpenCode's v2 catalog is location-scoped: a reply answers for one directory.

use ace_protocol::generated::ProviderKind;

/// How the catalog may open an ACP agent's metadata-only probe session (ADR 0044).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelProbe {
    /// A reviewed profile, probed the first time a read asks for this row.
    Automatic,
    /// An unprofiled agent, probed only when the person asks for this row's models.
    OnRequest,
}

/// What lists an instance's models: its CLI, or Cursor's SDK worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Acp,
    CursorSdk,
}

/// One account (or local install) whose models ace lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInstance {
    pub id: String,
    pub label: Option<String>,
    pub provider: ProviderKind,
    pub acp_agent_id: Option<String>,
    /// The ACP agent's reported version: reviewed profiles are matched by it.
    pub installation_version: Option<String>,
    pub installation_id: Option<String>,
    pub instance_id: Option<String>,
    /// An ACP agent's profile revision.
    pub profile_revision: Option<String>,
    /// Changes whenever the account's login changes; a cached row is keyed by it.
    pub login_revision: String,
    /// See [`ModelProbe`].
    pub model_probe: Option<ModelProbe>,
    /// The ACP method the person signed in with.
    pub sign_in_method: Option<String>,
    /// The directory the provider was asked about; OpenCode's catalog echoes it.
    pub cwd: String,
    /// The executable discovery launches; empty for SDK-backed instances.
    pub executable: String,
    pub args: Vec<String>,
    /// The SDK worker's private home, for instance-scoped accounts.
    pub home_dir: Option<String>,
    pub backend: Option<Backend>,
    /// OpenCode: run commands with a private server, never the person's.
    pub isolated_service: bool,
    /// The launch environment discovery adds.
    pub env: Vec<(String, String)>,
    /// Variables the discovery process must not inherit.
    pub unset_env: Vec<String>,
}

impl ModelInstance {
    /// A CLI-backed instance in `cwd`, with no ACP identity.
    pub fn cli(id: &str, provider: ProviderKind, executable: &str, cwd: &str) -> Self {
        Self {
            id: id.to_owned(),
            label: None,
            provider,
            acp_agent_id: None,
            installation_version: None,
            installation_id: None,
            instance_id: None,
            profile_revision: None,
            login_revision: "1".to_owned(),
            model_probe: None,
            sign_in_method: None,
            cwd: cwd.to_owned(),
            executable: executable.to_owned(),
            args: Vec::new(),
            home_dir: None,
            backend: None,
            isolated_service: false,
            env: Vec::new(),
            unset_env: Vec::new(),
        }
    }

    /// The label a source shows: the instance's own or its id.
    pub fn source_label(&self) -> &str {
        self.label.as_deref().unwrap_or(&self.id)
    }
}
