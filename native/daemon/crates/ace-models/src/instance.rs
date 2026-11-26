// SPDX-License-Identifier: Apache-2.0
//! The provider account a catalog row came from.
//!
//! The catalog's slice of `packages/models/src/types.ts`'s `ModelInstance` (loginRevision,
//! profileRevision and the probe settings belong to discovery, not row shaping). `cwd` is
//! here because OpenCode's v2 catalog is location-scoped: a reply answers for one directory.

use ace_protocol::generated::ProviderKind;

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
    /// The directory the provider was asked about; OpenCode's catalog echoes it.
    pub cwd: String,
    /// The executable discovery launches; empty for SDK-backed instances.
    pub executable: String,
    pub args: Vec<String>,
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
            cwd: cwd.to_owned(),
            executable: executable.to_owned(),
            args: Vec::new(),
        }
    }

    /// The label a source shows: the instance's own or its id.
    pub fn source_label(&self) -> &str {
        self.label.as_deref().unwrap_or(&self.id)
    }
}
