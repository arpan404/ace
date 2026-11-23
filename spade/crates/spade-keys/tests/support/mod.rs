//! The mock keychain, counting the secrets read from it and optionally pausing a read: a read
//! still waiting on a prompt, in a test.

#![allow(dead_code)]

use std::any::Any;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use keyring_core::api::{CredentialApi, CredentialStoreApi};
use keyring_core::{Credential, CredentialStore, Entry, Result};

/// Runs inside a read, before the mock answers.
pub type Hook = Arc<dyn Fn() + Send + Sync>;

pub struct Counting {
    pub inner: Arc<CredentialStore>,
    reads: Arc<AtomicUsize>,
    hook: Arc<Mutex<Option<Hook>>>,
}

impl Counting {
    pub fn new() -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            inner: keyring_core::mock::Store::new()?,
            reads: Arc::default(),
            hook: Arc::default(),
        }))
    }

    /// Secrets read from the store so far.
    pub fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    /// Runs `hook` inside every later read.
    pub fn during_reads(&self, hook: Option<Hook>) {
        *self.hook.lock().unwrap_or_else(|p| p.into_inner()) = hook;
    }

    /// Stores a secret behind Spade's back, as another app (or an older Spade) would.
    pub fn store_directly(&self, service: &str, account: &str, secret: &str) -> Result<()> {
        self.inner
            .build(service, account, None)?
            .set_password(secret)
    }

    pub fn stored(&self, service: &str, account: &str) -> Option<String> {
        self.inner
            .build(service, account, None)
            .ok()?
            .get_password()
            .ok()
    }
}

impl std::fmt::Debug for Counting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Counting")
    }
}

impl CredentialStoreApi for Counting {
    fn vendor(&self) -> String {
        "counting mock".to_owned()
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
        let cred: Arc<Credential> = Arc::new(CountingCred {
            inner: self.inner.build(service, user, mods)?,
            reads: self.reads.clone(),
            hook: self.hook.clone(),
        });
        Ok(Entry::new_with_credential(cred))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

struct CountingCred {
    inner: Entry,
    reads: Arc<AtomicUsize>,
    hook: Arc<Mutex<Option<Hook>>>,
}

impl std::fmt::Debug for CountingCred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CountingCred")
    }
}

impl CredentialApi for CountingCred {
    fn set_secret(&self, secret: &[u8]) -> Result<()> {
        self.inner.set_secret(secret)
    }

    fn get_secret(&self) -> Result<Vec<u8>> {
        let hook = self.hook.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(hook) = hook {
            hook();
        }
        let secret = self.inner.get_secret();
        if secret.is_ok() {
            self.reads.fetch_add(1, Ordering::SeqCst);
        }
        secret
    }

    fn delete_credential(&self) -> Result<()> {
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
