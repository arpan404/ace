// SPDX-License-Identifier: Apache-2.0
//! The only OS boundary. A stable allocation keeps the locked address unchanged.
use crate::Error;
use ring::aead::{CHACHA20_POLY1305, LessSafeKey, UnboundKey};
use std::mem::MaybeUninit;
use zeroize::{Zeroize, Zeroizing};
pub(crate) struct Key {
    page: Box<KeyPage>,
    locked: bool,
}
// Isolate key pages so unlocking one key cannot unlock another live key.
#[repr(align(65536))]
struct KeyPage {
    bytes: Zeroizing<[u8; 32]>,
    expanded: MaybeUninit<LessSafeKey>,
    initialized: bool,
}
impl Key {
    pub(crate) fn new(mut source: Zeroizing<[u8; 32]>) -> Result<Self, Error> {
        let mut key = Self {
            page: Box::new(KeyPage {
                bytes: Zeroizing::new([0; 32]),
                expanded: MaybeUninit::zeroed(),
                initialized: false,
            }),
            locked: false,
        };
        key.locked = lock(
            (&*key.page as *const KeyPage).cast(),
            std::mem::size_of::<KeyPage>(),
        );
        key.page.bytes.copy_from_slice(source.as_ref());
        source.zeroize();
        key.initialize()?;
        Ok(key)
    }
    fn initialize(&mut self) -> Result<(), Error> {
        let key = LessSafeKey::new(
            UnboundKey::new(&CHACHA20_POLY1305, self.page.bytes.as_ref())
                .map_err(|_| Error::InvalidKeyBlock)?,
        );
        self.page.expanded.write(key);
        self.page.initialized = true;
        Ok(())
    }
    #[allow(unsafe_code)]
    pub(crate) fn cipher(&self) -> &LessSafeKey {
        // SAFETY: constructor and replacement initialize before exposing the key.
        unsafe { self.page.expanded.assume_init_ref() }
    }
    #[allow(unsafe_code)]
    fn wipe_expanded(&mut self) {
        if self.page.initialized {
            // SAFETY: initialized exactly once, never used after this drop. In ring
            // 0.17.14 the ChaCha key is inline, with no heap-owned key schedule.
            unsafe {
                self.page.expanded.assume_init_drop();
            }
            self.page.initialized = false;
        }
        // MaybeUninit permits all-zero bits, including the former static pointer.
        // SAFETY: cover exactly this allocation's expanded-key field as uninitialized
        // bytes, so padding is wiped too and no invalid LessSafeKey is created.
        let storage = unsafe {
            std::slice::from_raw_parts_mut(
                (&mut self.page.expanded as *mut MaybeUninit<LessSafeKey>)
                    .cast::<MaybeUninit<u8>>(),
                std::mem::size_of::<LessSafeKey>(),
            )
        };
        storage.zeroize();
    }
    pub(crate) fn replace(&mut self, value: &[u8]) -> Result<(), Error> {
        self.wipe_expanded();
        self.page.bytes.zeroize();
        self.page.bytes.copy_from_slice(value);
        self.initialize()
    }
}
impl Drop for Key {
    fn drop(&mut self) {
        self.wipe_expanded();
        self.page.bytes.zeroize();
        if self.locked || cfg!(windows) {
            unlock(
                (&*self.page as *const KeyPage).cast(),
                std::mem::size_of::<KeyPage>(),
            );
        }
    }
}
#[cfg(unix)]
#[allow(unsafe_code)]
fn lock(ptr: *const u8, len: usize) -> bool {
    // SAFETY: the boxed allocation is live and stable until after munlock.
    unsafe { libc::mlock(ptr.cast(), len) == 0 }
}
#[cfg(unix)]
#[allow(unsafe_code)]
fn unlock(ptr: *const u8, len: usize) {
    // SAFETY: called before the allocation is freed, after wiping it.
    unsafe {
        libc::munlock(ptr.cast(), len);
    }
}
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn VirtualLock(address: *const u8, size: usize) -> i32;
        pub fn VirtualUnlock(address: *const u8, size: usize) -> i32;
    }
    #[link(name = "wer")]
    unsafe extern "system" {
        pub fn WerRegisterExcludedMemoryBlock(address: *const u8, size: u32) -> i32;
        pub fn WerUnregisterExcludedMemoryBlock(address: *const u8) -> i32;
    }
    pub fn lock(ptr: *const u8, len: usize) -> bool {
        // SAFETY: caller holds a stable allocation until unlock.
        unsafe {
            WerRegisterExcludedMemoryBlock(ptr, len as u32);
            VirtualLock(ptr, len) != 0
        }
    }
    pub fn unlock(ptr: *const u8, len: usize) {
        // SAFETY: the allocation is still live.
        unsafe {
            WerUnregisterExcludedMemoryBlock(ptr);
            VirtualUnlock(ptr, len);
        }
    }
}
#[cfg(windows)]
use windows::{lock, unlock};
#[cfg(not(any(unix, windows)))]
fn lock(_: *const u8, _: usize) -> bool {
    false
}
#[cfg(not(any(unix, windows)))]
fn unlock(_: *const u8, _: usize) {}

/// Best-effort page locking for other secret storage in the process (the lane secret, tickets
/// and tokens): the caller keeps the allocation stable and unlocks it before freeing it.
pub fn lock_memory(bytes: &[u8]) -> bool {
    lock(bytes.as_ptr(), bytes.len())
}
pub fn unlock_memory(bytes: &[u8]) {
    unlock(bytes.as_ptr(), bytes.len());
}

/// Install at process startup, before reading control payloads. Never formats PanicInfo.
pub fn install_payload_free_panic_hook() {
    std::panic::set_hook(Box::new(|_| eprintln!("ace-media: panic")));
}
