//! Where a signed-in account's tokens rest (ADR 0214): sealed (ChaCha20-Poly1305) in one file
//! per account in Spade's data folder, with a random 32-byte key per account in the OS keychain
//! under `oauth:<account id>`. The keychain entry is small and its name a fixed length, so every
//! platform's credential store takes it; the file is replaced whole by renaming a new one over
//! it, so the two tokens are always read and written as a pair. The account id is bound into the
//! seal, so one account's file never opens as another's. Blocking: call it off the async
//! workers.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, Nonce, UnboundKey};
use serde_json::{Value, json};
use spade_connect::oauth::pkce::Random;
use spade_keys::KeyStore;

/// The seal's format, written first so a later one can be told apart.
const VERSION: u8 = 1;
const NONCE: usize = 12;
const KEY: usize = 32;

/// Sealed sign-ins in a folder, their keys in a keychain.
pub struct Vault {
    dir: PathBuf,
    keys: KeyStore,
    random: Arc<dyn Random>,
}

impl Vault {
    pub fn new(dir: impl Into<PathBuf>, keys: KeyStore, random: Arc<dyn Random>) -> Self {
        Self {
            dir: dir.into(),
            keys,
            random,
        }
    }

    /// The account's tokens (access, refresh), if both its key and its sealed file are there
    /// and open. A file that won't open with the key it has reads as none: signed out.
    pub fn read(&self, account: &str) -> Result<Option<(String, String)>, String> {
        let path = self.path(account)?;
        let Some(key) = self.key(account)? else {
            return Ok(None);
        };
        let sealed = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("the sealed sign-in could not be read: {error}")),
        };
        let Some(plain) = open(&key, account, sealed) else {
            tracing::warn!(
                account,
                "a sealed sign-in did not open; it reads as signed out"
            );
            return Ok(None);
        };
        let value: Value = serde_json::from_slice(&plain).unwrap_or(Value::Null);
        let part = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
        Ok(part("access").zip(part("refresh")))
    }

    /// Seals the account's tokens, replacing any earlier pair whole.
    pub fn write(&self, account: &str, access: &str, refresh: &str) -> Result<(), String> {
        let path = self.path(account)?;
        let key = match self.key(account)? {
            Some(key) => key,
            None => {
                let mut key = [0u8; KEY];
                self.random.fill(&mut key)?;
                self.keys
                    .set_sign_in_key(account, &hex(&key))
                    .map_err(|e| e.to_string())?;
                key
            }
        };
        let plain = json!({ "access": access, "refresh": refresh }).to_string();
        let mut nonce = [0u8; NONCE];
        self.random.fill(&mut nonce)?;
        let sealed = seal(&key, account, nonce, plain.into_bytes())?;
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let mut tag = [0u8; 8];
        self.random.fill(&mut tag)?;
        let temporary = self.dir.join(format!(".{account}.{}.tmp", hex(&tag)));
        write_private(&temporary, &sealed).map_err(|e| e.to_string())?;
        fs::rename(&temporary, &path).map_err(|e| {
            let _ = fs::remove_file(&temporary);
            format!("the sealed sign-in could not be put in place: {e}")
        })
    }

    /// Forgets the account's tokens: its sealed file and its key. Returns whether either was
    /// there.
    pub fn erase(&self, account: &str) -> Result<bool, String> {
        let path = self.path(account)?;
        let file = match fs::remove_file(&path) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(format!("the sealed sign-in could not be removed: {error}")),
        };
        let key = self
            .keys
            .delete_sign_in_key(account)
            .map_err(|e| e.to_string())?;
        Ok(file || key)
    }

    /// Whether anything of the account's sign-in is kept: its key or its sealed file.
    pub fn holds(&self, account: &str) -> Result<bool, String> {
        Ok(self.path(account)?.exists() || self.key(account)?.is_some())
    }

    fn key(&self, account: &str) -> Result<Option<[u8; KEY]>, String> {
        let Some(text) = self.keys.sign_in_key(account).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        Ok(unhex(&text))
    }

    /// The account's sealed file. Only an id Spade makes (lowercase letters, digits, dashes) is
    /// a file name, so nothing reaches outside the folder.
    fn path(&self, account: &str) -> Result<PathBuf, String> {
        let plain = !account.is_empty()
            && account.len() <= 80
            && account
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !plain {
            return Err("that is not an account id".to_owned());
        }
        Ok(self.dir.join(account))
    }
}

fn sealing_key(key: &[u8; KEY]) -> Result<LessSafeKey, String> {
    UnboundKey::new(&CHACHA20_POLY1305, key)
        .map(LessSafeKey::new)
        .map_err(|_| "the sealing key is unusable".to_owned())
}

fn seal(
    key: &[u8; KEY],
    account: &str,
    nonce: [u8; NONCE],
    mut data: Vec<u8>,
) -> Result<Vec<u8>, String> {
    sealing_key(key)?
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(account.as_bytes()),
            &mut data,
        )
        .map_err(|_| "the sign-in could not be sealed".to_owned())?;
    let mut out = Vec::with_capacity(1 + NONCE + data.len());
    out.push(VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&data);
    Ok(out)
}

fn open(key: &[u8; KEY], account: &str, sealed: Vec<u8>) -> Option<Vec<u8>> {
    if sealed.len() < 1 + NONCE || sealed[0] != VERSION {
        return None;
    }
    let nonce: [u8; NONCE] = sealed[1..=NONCE].try_into().ok()?;
    let mut data = sealed[1 + NONCE..].to_vec();
    let plain = sealing_key(key)
        .ok()?
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(account.as_bytes()),
            &mut data,
        )
        .ok()?;
    Some(plain.to_vec())
}

/// Writes `bytes` to a new file only this user can read.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<[u8; KEY]> {
    let text = text.trim();
    if text.len() != KEY * 2 {
        return None;
    }
    let mut out = [0u8; KEY];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Counter(std::sync::atomic::AtomicU8);

    impl Random for Counter {
        fn fill(&self, buf: &mut [u8]) -> Result<(), String> {
            let n = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            buf.iter_mut().enumerate().for_each(|(i, b)| {
                *b = n.wrapping_add(u8::try_from(i % 251).unwrap_or(0));
            });
            Ok(())
        }
    }

    fn vault(dir: &Path) -> Result<Vault, Box<dyn std::error::Error>> {
        let keys = KeyStore::with_store(keyring_core::mock::Store::new()?, spade_keys::SERVICE);
        Ok(Vault::new(dir, keys, Arc::new(Counter(Default::default()))))
    }

    #[test]
    fn a_pair_is_sealed_at_rest_read_back_whole_and_erased_with_its_key()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let vault = vault(dir.path())?;
        vault.write("chatgpt-a", "access-1", "refresh-1")?;
        let on_disk = fs::read(dir.path().join("chatgpt-a"))?;
        let shown = String::from_utf8_lossy(&on_disk);
        assert!(
            !shown.contains("access-1") && !shown.contains("refresh-1"),
            "sealed at rest"
        );
        vault.write("chatgpt-a", "access-2", "refresh-2")?;
        assert_eq!(
            vault.read("chatgpt-a")?,
            Some(("access-2".to_owned(), "refresh-2".to_owned()))
        );
        assert!(vault.erase("chatgpt-a")?);
        assert_eq!(vault.read("chatgpt-a")?, None);
        assert!(!vault.holds("chatgpt-a")?);
        assert!(!vault.erase("chatgpt-a")?);
        Ok(())
    }

    #[test]
    fn one_accounts_sealed_file_never_opens_as_anothers() -> Result<(), Box<dyn std::error::Error>>
    {
        let dir = tempfile::tempdir()?;
        let vault = vault(dir.path())?;
        vault.write("chatgpt-a", "access-a", "refresh-a")?;
        vault.write("chatgpt-b", "access-b", "refresh-b")?;
        // Account b's file put in a's place: a's key and id don't open it.
        fs::copy(dir.path().join("chatgpt-b"), dir.path().join("chatgpt-a"))?;
        assert_eq!(vault.read("chatgpt-a")?, None);
        assert!(vault.read("../x").is_err(), "no path outside the folder");
        Ok(())
    }
}
