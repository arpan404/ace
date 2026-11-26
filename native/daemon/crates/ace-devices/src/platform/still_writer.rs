// SPDX-License-Identifier: Apache-2.0
//! `still-writer.ts`: a person's device screenshots on one authenticated connection, written
//! whole and in order. Live pictures never go this way (ace-media delivers them); each write
//! first runs its access check. The pieces' encoding, the transport and the access check are
//! the shell's; this decides when a screenshot is refused and how the queue is bounded.

/// A screenshot is refused rather than queued while the transport holds more than this: control
/// messages on the same channel must never find it backed up.
pub const STILL_BACKLOG_BYTES: usize = 128 * 1024;
/// Screenshots queued or being written at most.
pub const QUEUE_LIMIT: usize = 8;

/// Why a screenshot was not queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The writer is closed, or its queue is full.
    Unavailable,
    /// The connection holds more than the backlog bound.
    Congested,
    /// The writer closed while this screenshot waited its turn.
    Closed,
}

impl Refusal {
    pub fn message(self) -> &'static str {
        match self {
            Self::Unavailable => "Screenshot writer unavailable or full",
            Self::Congested => "Screenshot delivery congested; retry when the connection recovers",
            Self::Closed => "Screenshot writer closed",
        }
    }
}

/// The queue's state: ids, slots and the transport's backlog.
#[derive(Debug)]
pub struct StillWriter {
    queued: usize,
    ids: u32,
    closed: bool,
}

impl StillWriter {
    pub fn new() -> Self {
        Self {
            queued: 0,
            ids: 0,
            closed: false,
        }
    }

    /// Queues one screenshot and names it: its id is the connection's next, wrapping at 32
    /// bits. A closed or full writer, or a congested connection, refuses it without an id.
    pub fn begin(&mut self, buffered_bytes: usize) -> Result<u32, Refusal> {
        if self.closed || self.queued >= QUEUE_LIMIT {
            return Err(Refusal::Unavailable);
        }
        if buffered_bytes > STILL_BACKLOG_BYTES {
            return Err(Refusal::Congested);
        }
        self.ids = self.ids.wrapping_add(1);
        self.queued += 1;
        Ok(self.ids)
    }

    /// The screenshot's turn came: a writer that closed meanwhile refuses it.
    pub fn writing(&self) -> Result<(), Refusal> {
        if self.closed {
            return Err(Refusal::Closed);
        }
        Ok(())
    }

    /// One queued screenshot finished, whatever its outcome.
    pub fn finish(&mut self) {
        self.queued = self.queued.saturating_sub(1);
    }

    pub fn close(&mut self) {
        self.closed = true;
    }

    pub fn queued(&self) -> usize {
        self.queued
    }
}

impl Default for StillWriter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_most_eight_screenshots_are_queued_and_a_freed_slot_takes_the_next() {
        let mut writer = StillWriter::new();
        for _ in 0..QUEUE_LIMIT {
            assert!(writer.begin(0).is_ok());
        }
        assert_eq!(writer.begin(0), Err(Refusal::Unavailable));
        writer.finish();
        assert!(writer.begin(0).is_ok());
        assert_eq!(writer.queued(), QUEUE_LIMIT);
    }

    #[test]
    fn a_connection_over_the_backlog_bound_refuses_before_it_is_queued() {
        let mut writer = StillWriter::new();
        assert!(writer.begin(STILL_BACKLOG_BYTES).is_ok());
        assert_eq!(
            writer.begin(STILL_BACKLOG_BYTES + 1),
            Err(Refusal::Congested)
        );
        assert_eq!(writer.queued(), 1, "a refused screenshot takes no slot");
    }

    #[test]
    fn ids_count_up_and_wrap_at_32_bits() {
        let mut writer = StillWriter::new();
        writer.ids = u32::MAX - 1;
        assert_eq!(writer.begin(0), Ok(u32::MAX));
        assert_eq!(writer.begin(0), Ok(0));
    }

    #[test]
    fn a_writer_that_closes_refuses_the_queue_and_what_waited_in_it() {
        let mut writer = StillWriter::new();
        assert!(writer.begin(0).is_ok());
        writer.close();
        assert_eq!(writer.begin(0), Err(Refusal::Unavailable));
        assert_eq!(writer.writing(), Err(Refusal::Closed));
        assert_eq!(
            Refusal::Congested.message(),
            "Screenshot delivery congested; retry when the connection recovers"
        );
    }
}
