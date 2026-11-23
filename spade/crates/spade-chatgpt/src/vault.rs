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
/// The most a sealed pair can be: two JSON Web Tokens with room to spare. Nothing larger is read.
const MOST_SEALED: u64 = 64 * 1024;

/// Sealed sign-ins in a folder, their keys in a keychain.
pub struct Vault {
    dir: PathBuf,
    keys: KeyStore,
    random: Arc<dyn Random>,
    /// For tests: run with a sealed file's path right before it is opened.
    #[cfg(test)]
    before_open: Option<Arc<BeforeOpen>>,
}

/// A test's step between finding a sealed file's path and opening it.
#[cfg(test)]
type BeforeOpen = dyn Fn(&Path) + Send + Sync;

impl Vault {
    pub fn new(dir: impl Into<PathBuf>, keys: KeyStore, random: Arc<dyn Random>) -> Self {
        Self {
            dir: dir.into(),
            keys,
            #[cfg(test)]
            before_open: None,
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
        let Some(sealed) = self.read_sealed(&path)? else {
            return Ok(None);
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
        private_dir(&self.dir).map_err(|e| format!("the sign-in folder could not be made: {e}"))?;
        self.checked_dir()?;
        let mut tag = [0u8; 8];
        self.random.fill(&mut tag)?;
        let temporary = self.dir.join(format!(".{account}.{}.tmp", hex(&tag)));
        write_private(&temporary, &sealed).map_err(|e| e.to_string())?;
        fs::rename(&temporary, &path).map_err(|e| {
            let _ = fs::remove_file(&temporary);
            format!("the sealed sign-in could not be put in place: {e}")
        })
    }

    /// Forgets the account's tokens: its key first, whatever happens to the file (a file left
    /// without its key never opens again), then its sealed file. Returns whether either was there;
    /// a part that couldn't go is an error, after the other was tried.
    pub fn erase(&self, account: &str) -> Result<bool, String> {
        let path = self.path(account)?;
        let key = self.keys.delete_sign_in_key(account);
        let file = match fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("the sealed sign-in could not be removed: {error}")),
        };
        let key = key.map_err(|e| e.to_string())?;
        Ok(file? || key)
    }

    /// The vault's folder, checked to be a folder itself, never a link to one elsewhere.
    fn checked_dir(&self) -> Result<(), String> {
        let meta = fs::symlink_metadata(&self.dir)
            .map_err(|e| format!("the sign-in folder could not be read: {e}"))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("the sign-in folder is not a folder".to_owned());
        }
        Ok(())
    }

    /// The sealed file at `path`, if it is a plain file of a sealed pair's size: never through a
    /// link, never a pipe or device that could hold the read open, never more than
    /// [`MOST_SEALED`]. Anything else reads as none.
    fn read_sealed(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        match fs::symlink_metadata(&self.dir) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            _ => self.checked_dir()?,
        }
        #[cfg(test)]
        if let Some(hook) = &self.before_open {
            hook(path);
        }
        // Opened first, then the opened file is checked: nothing can be swapped in between. The
        // open never follows a link and never waits on a pipe.
        let file = match open_plain(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) if is_link(&error) => {
                tracing::warn!("a sealed sign-in is a link; it reads as none");
                return Ok(None);
            }
            Err(error) => return Err(format!("the sealed sign-in could not be read: {error}")),
        };
        let meta = file
            .metadata()
            .map_err(|e| format!("the sealed sign-in could not be read: {e}"))?;
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MOST_SEALED {
            tracing::warn!("a sealed sign-in is not a plain file of its size; it reads as none");
            return Ok(None);
        }
        let mut sealed = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(file, MOST_SEALED + 1), &mut sealed)
            .map_err(|e| format!("the sealed sign-in could not be read: {e}"))?;
        if sealed.len() as u64 > MOST_SEALED {
            return Ok(None);
        }
        Ok(Some(sealed))
    }

    /// Whether the account's sign-in is whole: its key and a plain sealed file both there. A home
    /// restored without its keychain has the files but not the keys.
    pub fn complete(&self, account: &str) -> Result<bool, String> {
        let path = self.path(account)?;
        if self.key(account)?.is_none() {
            return Ok(false);
        }
        Ok(fs::symlink_metadata(&path)
            .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink()))
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

/// Opens `path` for reading without following a link at it and without waiting on a pipe or
/// device: `O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC` on Unix, `FILE_FLAG_OPEN_REPARSE_POINT` on
/// Windows (a link or reparse point is opened as itself, and then refused as not a plain file).
fn open_plain(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        /// `FILE_FLAG_OPEN_REPARSE_POINT`.
        const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(OPEN_REPARSE_POINT);
    }
    options.open(path)
}

/// Whether opening failed because the path is a link (`ELOOP` under `O_NOFOLLOW`).
fn is_link(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::ELOOP)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

/// Makes the folder only this user can open: `0700` on Unix, an owner-only DACL on Windows, set
/// as it is made. One already there is left as it is.
fn private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        if let Some(parent) = dir.parent() {
            fs::create_dir_all(parent)?;
        }
        spade_sandbox_windows::private::create_dir(dir)
    }
    #[cfg(not(windows))]
    {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(dir)
    }
}

/// Writes `bytes` to a new file only this user can read: `0600` on Unix, an owner-only DACL on
/// Windows, set as the file is made, before any byte is written.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(windows)]
    let mut file = spade_sandbox_windows::private::create_new_file(path)?;
    #[cfg(not(windows))]
    let mut file = {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)?
    };
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

    /// Reads `account` on another thread, giving up after a few seconds: a read that blocks
    /// fails the test instead of hanging it.
    fn read_or_hang(
        dir: &Path,
        keys: KeyStore,
        account: &'static str,
    ) -> Result<Option<(String, String)>, Box<dyn std::error::Error>> {
        let (tx, rx) = std::sync::mpsc::channel();
        let dir = dir.to_path_buf();
        std::thread::spawn(move || {
            let vault = Vault::new(dir, keys, Arc::new(Counter(Default::default())));
            let _ = tx.send(vault.read(account));
        });
        Ok(rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|_| "the read blocked")??)
    }

    #[cfg(unix)]
    #[test]
    fn a_sealed_file_that_is_a_link_or_a_pipe_reads_as_none_without_blocking()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let keys = KeyStore::with_store(keyring_core::mock::Store::new()?, spade_keys::SERVICE);
        let vault = Vault::new(
            dir.path(),
            keys.clone(),
            Arc::new(Counter(Default::default())),
        );
        vault.write("chatgpt-a", "access-a", "refresh-a")?;
        vault.write("chatgpt-b", "access-b", "refresh-b")?;
        // A pipe in a's place, and b's place a link to it: opening either would wait forever.
        let pipe = dir.path().join("pipe");
        let made = std::process::Command::new("mkfifo").arg(&pipe).status()?;
        assert!(made.success());
        fs::remove_file(dir.path().join("chatgpt-a"))?;
        std::process::Command::new("mkfifo")
            .arg(dir.path().join("chatgpt-a"))
            .status()?;
        fs::remove_file(dir.path().join("chatgpt-b"))?;
        std::os::unix::fs::symlink(&pipe, dir.path().join("chatgpt-b"))?;
        assert_eq!(read_or_hang(dir.path(), keys.clone(), "chatgpt-a")?, None);
        assert_eq!(read_or_hang(dir.path(), keys, "chatgpt-b")?, None);
        Ok(())
    }

    #[test]
    fn a_key_goes_even_when_its_file_cannot_and_the_file_left_never_opens()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let keys = KeyStore::with_store(keyring_core::mock::Store::new()?, spade_keys::SERVICE);
        let vault = Vault::new(
            dir.path(),
            keys.clone(),
            Arc::new(Counter(Default::default())),
        );
        vault.write("chatgpt-a", "access-a", "refresh-a")?;
        // Something holds the file's place that can't be removed as a file.
        fs::remove_file(dir.path().join("chatgpt-a"))?;
        fs::create_dir(dir.path().join("chatgpt-a"))?;
        fs::write(dir.path().join("chatgpt-a").join("held"), b"x")?;
        assert!(vault.erase("chatgpt-a").is_err());
        assert_eq!(
            keys.sign_in_key("chatgpt-a")?,
            None,
            "the key went regardless"
        );
        assert_eq!(vault.read("chatgpt-a")?, None);
        Ok(())
    }

    #[test]
    fn a_key_left_without_its_file_reads_as_signed_out_and_goes_on_erase()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let keys = KeyStore::with_store(keyring_core::mock::Store::new()?, spade_keys::SERVICE);
        let vault = Vault::new(
            dir.path(),
            keys.clone(),
            Arc::new(Counter(Default::default())),
        );
        // As a first write stopped between its key and its file leaves it.
        keys.set_sign_in_key("chatgpt-a", &"ab".repeat(KEY))?;
        assert_eq!(vault.read("chatgpt-a")?, None);
        assert!(vault.holds("chatgpt-a")?);
        assert!(vault.erase("chatgpt-a")?);
        assert_eq!(keys.sign_in_key("chatgpt-a")?, None);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_link_or_a_pipe_swapped_in_just_before_the_open_reads_as_none_without_blocking()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let keys = KeyStore::with_store(keyring_core::mock::Store::new()?, spade_keys::SERVICE);
        let pipe = dir.path().join("pipe");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&pipe)
                .status()?
                .success()
        );
        for swap_in_link in [true, false] {
            let mut vault = Vault::new(
                dir.path(),
                keys.clone(),
                Arc::new(Counter(Default::default())),
            );
            vault.write("chatgpt-a", "access-a", "refresh-a")?;
            // A plain sealed file when looked at; something else by the time it is opened.
            let pipe = pipe.clone();
            vault.before_open = Some(Arc::new(move |path: &Path| {
                let _ = fs::remove_file(path);
                if swap_in_link {
                    let _ = std::os::unix::fs::symlink(&pipe, path);
                } else {
                    let _ = std::process::Command::new("mkfifo").arg(path).status();
                }
            }));
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(vault.read("chatgpt-a"));
            });
            let read = rx
                .recv_timeout(std::time::Duration::from_secs(3))
                .map_err(|_| "the read blocked")?;
            assert_eq!(read?, None, "link: {swap_in_link}");
        }
        Ok(())
    }
}
