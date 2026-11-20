// SPDX-License-Identifier: Apache-2.0

//! Hands memory the process has freed back to the operating system.
//!
//! glibc keeps freed memory in its heaps for the next allocation, and a heap only shrinks from its
//! top. Replacing the quick-open index frees tens of megabytes at once (the old index, and the
//! walk that built the new one), and without a trim that memory stayed resident for as long as
//! the process lived: each folder rescan after a burst left the process larger than before it.

/// Returns whole free pages to the OS, where the allocator keeps them otherwise.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[allow(unsafe_code)]
pub fn release() {
    // SAFETY: `malloc_trim` takes no pointers and only rearranges the allocator's own free lists;
    // it is safe to call from any thread at any time.
    unsafe {
        libc::malloc_trim(0);
    }
}

/// Other allocators return freed memory on their own, or offer no way to ask.
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
pub fn release() {}
