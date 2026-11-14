// SPDX-License-Identifier: Apache-2.0
//! Media Foundation samples: making them, reading them, and knowing when an MFT has let
//! go of one.
use super::com::Ctx;
use super::surface::MfSurface;
use media_codec::CodecError;
use std::time::{Duration, Instant};
use windows::Win32::Media::MediaFoundation::*;
use windows_core::Interface;

/// The bytes of a sample, appended to `out` after clearing it.
pub(crate) fn sample_bytes(sample: &IMFSample, out: &mut Vec<u8>) -> Result<(), CodecError> {
    out.clear();
    // SAFETY: The buffer is locked, copied and unlocked here.
    unsafe {
        let buffer = sample
            .ConvertToContiguousBuffer()
            .ctx("ConvertToContiguousBuffer")?;
        let mut data = std::ptr::null_mut();
        let mut len = 0u32;
        buffer.Lock(&mut data, None, Some(&mut len)).ctx("Lock")?;
        if !data.is_null() {
            out.extend_from_slice(std::slice::from_raw_parts(data, len as usize));
        }
        buffer.Unlock().ctx("Unlock")?;
    }
    Ok(())
}

/// A system-memory buffer holding `bytes`.
pub(crate) fn memory_buffer(bytes: &[u8]) -> Result<IMFMediaBuffer, CodecError> {
    let len = u32::try_from(bytes.len())
        .map_err(|_| CodecError::InvalidInput("sample over 4 GiB".into()))?;
    // SAFETY: Fresh buffer of `len` bytes, filled under its lock.
    unsafe {
        let buffer = MFCreateMemoryBuffer(len).ctx("MFCreateMemoryBuffer")?;
        let mut data = std::ptr::null_mut();
        buffer.Lock(&mut data, None, None).ctx("Lock")?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len());
        buffer.Unlock().ctx("Unlock")?;
        buffer.SetCurrentLength(len).ctx("SetCurrentLength")?;
        Ok(buffer)
    }
}

/// A sample holding `bytes` in system memory, timed in 100 ns units.
pub(crate) fn memory_sample(
    bytes: &[u8],
    pts_us: u64,
    duration_us: u64,
) -> Result<IMFSample, CodecError> {
    timed_sample(&memory_buffer(bytes)?, pts_us, duration_us)
}

pub(crate) fn timed_sample(
    buffer: &IMFMediaBuffer,
    pts_us: u64,
    duration_us: u64,
) -> Result<IMFSample, CodecError> {
    // SAFETY: Attribute writes on a fresh sample.
    unsafe {
        let sample = MFCreateSample().ctx("MFCreateSample")?;
        sample.AddBuffer(buffer).ctx("AddBuffer")?;
        sample
            .SetSampleTime((pts_us * 10) as i64)
            .ctx("SetSampleTime")?;
        sample
            .SetSampleDuration((duration_us * 10) as i64)
            .ctx("SetSampleDuration")?;
        Ok(sample)
    }
}

/// How many references `buffer` has, ours included.
fn references(buffer: &IMFMediaBuffer) -> u32 {
    let unknown = &buffer.vtable().base__;
    // SAFETY: A balanced AddRef/Release pair on a live interface; Release returns the
    // count after it, which is the count before the pair.
    unsafe {
        (unknown.AddRef)(buffer.as_raw());
        (unknown.Release)(buffer.as_raw())
    }
}

struct Entry {
    buffer: IMFMediaBuffer,
    /// The texture behind a DXGI buffer, held (with its ring lease) until the MFT is done.
    _surface: Option<MfSurface>,
}

/// Input an MFT still holds, tracked by the sample's buffer: an entry ends when the MFT
/// has released the sample (only our reference to the buffer remains), whether or not it
/// produced output for it. A dropped frame therefore frees its slot and its texture.
pub(crate) struct InFlight {
    entries: Vec<Entry>,
    last_progress: Option<Instant>,
}

impl InFlight {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: Vec::with_capacity(capacity),
            last_progress: None,
        }
    }

    pub fn push(&mut self, buffer: IMFMediaBuffer, surface: Option<MfSurface>, now: Instant) {
        if self.entries.is_empty() {
            self.last_progress = Some(now);
        }
        self.entries.push(Entry {
            buffer,
            _surface: surface,
        });
    }

    /// The input was refused: forget the newest entry.
    pub fn cancel_last(&mut self) {
        self.entries.pop();
    }

    /// Ends entries the MFT has released. Call after output, or whenever input is asked for.
    pub fn sweep(&mut self) {
        self.entries.retain(|e| references(&e.buffer) > 1);
    }

    pub fn len(&mut self) -> usize {
        self.sweep();
        self.entries.len()
    }

    /// Output arrived: the MFT is alive.
    pub fn progressed(&mut self, now: Instant) {
        self.last_progress = Some(now);
        self.sweep();
    }

    /// Input has been held with no output for `limit`: the MFT has stalled.
    pub fn stalled(&mut self, now: Instant, limit: Duration) -> bool {
        self.len() > 0
            && self
                .last_progress
                .is_some_and(|t| now.saturating_duration_since(t) >= limit)
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.last_progress = None;
    }
}
