//! A keychain whose deletes wait on a [`Gate`]: a delete stuck on a prompt, in a test.

use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;

use keyring_core::api::{CredentialApi, CredentialStoreApi};
use keyring_core::{Credential, Entry, Result};

use super::Gate;

/// The mock store, with every credential delete waiting on `gate` first.
pub struct GatedStore {
    pub inner: Arc<keyring_core::mock::Store>,
    /// Deletes wait for it.
    pub gate: Option<Gate>,
    /// Reads wait for it, as on a keychain prompt nobody answered yet.
    pub reads: Option<Gate>,
}

impl std::fmt::Debug for GatedStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GatedStore")
    }
}

impl CredentialStoreApi for GatedStore {
    fn vendor(&self) -> String {
        "gated mock".to_owned()
    }

    fn id(&self) -> String {
        self.inner.id()
    }

    fn build(
        &self,
        service: &str,
        user: &str,
        mods: Option<&HashMap<&str, &str>>,
    ) -> Result<Entry> {
        let inner = self.inner.build(service, user, mods)?;
        let cred: Arc<Credential> = Arc::new(GatedCred {
            inner,
            gate: self.gate.clone(),
            reads: self.reads.clone(),
        });
        Ok(Entry::new_with_credential(cred))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

struct GatedCred {
    inner: Entry,
    gate: Option<Gate>,
    reads: Option<Gate>,
}

impl std::fmt::Debug for GatedCred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GatedCred")
    }
}

impl CredentialApi for GatedCred {
    fn set_secret(&self, secret: &[u8]) -> Result<()> {
        self.inner.set_secret(secret)
    }

    fn get_secret(&self) -> Result<Vec<u8>> {
        if let Some(reads) = &self.reads {
            reads.wait();
        }
        self.inner.get_secret()
    }

    fn delete_credential(&self) -> Result<()> {
        if let Some(gate) = &self.gate {
            assert!(!gate.take_panic(), "the keychain library panicked");
            gate.wait();
        }
        self.inner.delete_credential()
    }

    fn get_credential(&self) -> Result<Option<Arc<Credential>>> {
        Ok(None)
    }

    fn get_specifiers(&self) -> Option<(String, String)> {
        self.inner.get_specifiers()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}
