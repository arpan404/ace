// SPDX-License-Identifier: Apache-2.0
//! The image threads' shared memory budget (ADR 0201 §5): each job reserves what it will hold at
//! its peak (`media_image::peak_bytes`, from headers alone) before decoding, and waits for room
//! while its deadline allows. A job larger than the whole budget is refused at once.
use media_image::{Failed, ImageFailure};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// What the image process's jobs may hold at once. Its data limit (`os::limit_data`) sits above
/// this, for the allocator and the encoded inputs and outputs.
pub const BUDGET_BYTES: u64 = 768 * 1024 * 1024;

pub struct Budget {
    total: u64,
    used: Mutex<u64>,
    freed: Condvar,
}

/// Held for the job's life; dropping it gives the bytes back.
pub struct Reservation<'a> {
    budget: &'a Budget,
    bytes: u64,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut used) = self.budget.used.lock() {
            *used = used.saturating_sub(self.bytes);
        }
        self.budget.freed.notify_all();
    }
}

impl Budget {
    pub fn new(total: u64) -> Self {
        Self {
            total,
            used: Mutex::new(0),
            freed: Condvar::new(),
        }
    }

    /// Bytes reserved now.
    pub fn used(&self) -> u64 {
        self.used.lock().map_or(0, |used| *used)
    }

    /// Waits for `bytes` of room, checking `expired` every 20 ms.
    pub fn reserve(
        &self,
        bytes: u64,
        expired: &dyn Fn() -> bool,
    ) -> Result<Reservation<'_>, Failed> {
        if bytes > self.total {
            return Err(Failed::too_large(format!(
                "The image job needs about {} MiB, more than the {} MiB image jobs may hold.",
                bytes >> 20,
                self.total >> 20
            )));
        }
        let poisoned = || Failed::new(ImageFailure::Busy, "The image memory budget is unusable.");
        let mut used = self.used.lock().map_err(|_| poisoned())?;
        while *used + bytes > self.total {
            if expired() {
                return Err(Failed::new(
                    ImageFailure::Deadline,
                    "The image job's deadline passed while it waited for memory.",
                ));
            }
            used = self
                .freed
                .wait_timeout(used, Duration::from_millis(20))
                .map_err(|_| poisoned())?
                .0;
        }
        *used += bytes;
        Ok(Reservation {
            budget: self,
            bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_job_waits_for_room_takes_it_when_freed_and_gives_it_back() -> Result<(), String> {
        let budget = Arc::new(Budget::new(100));
        let first = budget.reserve(80, &|| false).map_err(|f| f.message)?;
        let waiter = {
            let budget = budget.clone();
            std::thread::spawn(move || {
                budget
                    .reserve(50, &|| false)
                    .map(|r| r.bytes)
                    .map_err(|f| f.reason)
            })
        };
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(
            budget.used(),
            80,
            "the second job must not fit beside the first"
        );
        drop(first);
        assert_eq!(waiter.join().map_err(|_| "panicked")?, Ok(50));
        assert_eq!(budget.used(), 0);
        Ok(())
    }

    #[test]
    fn a_job_larger_than_the_budget_or_out_of_time_is_refused_with_its_reason() {
        let budget = Budget::new(100);
        assert_eq!(
            budget.reserve(101, &|| false).err().map(|f| f.reason),
            Some(ImageFailure::TooLarge)
        );
        let _held = budget.reserve(100, &|| false);
        assert_eq!(
            budget.reserve(1, &|| true).err().map(|f| f.reason),
            Some(ImageFailure::Deadline)
        );
    }
}
