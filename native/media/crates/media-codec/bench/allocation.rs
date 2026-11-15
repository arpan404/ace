// SPDX-License-Identifier: Apache-2.0
//! Counts Rust allocator calls, including calls on worker threads. Native
//! framework mallocs are outside GlobalAlloc's visibility and are not counted.
#![allow(unsafe_code)]
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
struct Counting;
static ENABLED: AtomicBool = AtomicBool::new(false);
static CALLS: AtomicUsize = AtomicUsize::new(0);
#[global_allocator]
static ALLOCATOR: Counting = Counting;
fn count() {
    if ENABLED.load(Ordering::Relaxed) {
        CALLS.fetch_add(1, Ordering::Relaxed);
    }
}
// SAFETY: Every allocation/deallocation is forwarded unchanged to System. The
// instrumentation only touches atomics, so it neither allocates nor reenters.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count();
        unsafe { System.realloc(p, layout, size) }
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) }
    }
}
pub fn start() {
    CALLS.store(0, Ordering::SeqCst);
    ENABLED.store(true, Ordering::SeqCst);
}
pub fn stop() -> usize {
    ENABLED.store(false, Ordering::SeqCst);
    CALLS.load(Ordering::SeqCst)
}

pub fn calls() -> usize {
    CALLS.load(Ordering::Relaxed)
}
