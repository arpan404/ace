// SPDX-License-Identifier: Apache-2.0
//! The compression callback's output queue. Slots and their byte buffers are
//! allocated at configure time and recycled, so steady-state frames move bytes
//! without heap allocations.
#![allow(unsafe_code)]
use crate::cf;
use media_codec::{BitstreamFormat, Codec, CodecError, Size};
use objc2_core_foundation::{CFBoolean, CFData, CFDictionary, CFString, CFType};
use objc2_core_media::{
    CMSampleBuffer, kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms,
    kCMSampleAttachmentKey_NotSync,
};
use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// What a session's output is. Each slot is stamped with the stream that
/// produced it, so units queued before a reconfigure keep their own metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StreamMeta {
    pub codec: Codec,
    pub size: Size,
    pub format: BitstreamFormat,
    /// The configuration record's atom name: `avcC` or `hvcC`.
    pub atom: &'static str,
}

#[derive(Default)]
pub(crate) struct Slot {
    pub stream: Option<StreamMeta>,
    pub data: Vec<u8>,
    pub key: bool,
    pub pts_us: u64,
    pub duration_us: u64,
    pub description: Option<Vec<u8>>,
}

#[derive(Default)]
pub(crate) struct Queue {
    pub ready: VecDeque<Slot>,
    pub free: Vec<Slot>,
    pub in_flight: usize,
    pub error: Option<CodecError>,
    pub dropped: u64,
    /// The stream frames submitted from now on belong to; none for JPEG.
    pub stream: Option<StreamMeta>,
}

#[derive(Default)]
pub(crate) struct Shared {
    queue: Mutex<Queue>,
}
impl Shared {
    pub fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// Makes `count` slots of `capacity` bytes available before frames flow.
    pub fn reserve(&self, count: usize, capacity: usize) {
        let mut queue = self.lock();
        let total = queue.ready.len() + queue.free.len();
        queue.ready.reserve(count);
        queue.free.reserve(count);
        for slot in &mut queue.free {
            slot.data.reserve(capacity.saturating_sub(slot.data.len()));
        }
        for _ in total..count {
            queue.free.push(Slot {
                data: Vec::with_capacity(capacity),
                ..Slot::default()
            });
        }
    }
    /// Called on VideoToolbox's thread for each finished frame. A panic in the
    /// recording is caught (it must not unwind into VideoToolbox) and becomes
    /// a backend error; the in-flight count is released either way.
    pub fn complete(&self, status: i32, dropped: bool, sample: Option<&CMSampleBuffer>) {
        let recorded = catch_unwind(AssertUnwindSafe(|| self.record(status, dropped, sample)));
        let mut queue = self.lock();
        queue.in_flight = queue.in_flight.saturating_sub(1);
        if recorded.is_err() {
            queue.error = Some(CodecError::Backend(
                "VideoToolbox output callback panicked".into(),
            ));
        }
    }
    fn record(&self, status: i32, dropped: bool, sample: Option<&CMSampleBuffer>) {
        let mut queue = self.lock();
        if status != 0 {
            queue.error = Some(CodecError::Backend(format!(
                "VideoToolbox encode callback failed ({status})"
            )));
            return;
        }
        let Some(sample) = sample.filter(|_| !dropped) else {
            queue.dropped += 1;
            return;
        };
        let mut slot = queue.free.pop().unwrap_or_default();
        let stream = queue.stream;
        // Copy outside the lock would need a second slot hand-off; the copy is
        // one memcpy of the compressed frame.
        if let Err(error) = fill(&mut slot, sample, stream.map(|s| s.atom)) {
            queue.error = Some(error);
            queue.free.push(slot);
            return;
        }
        slot.stream = stream;
        queue.ready.push_back(slot);
    }
}

fn fill(slot: &mut Slot, sample: &CMSampleBuffer, atom: Option<&str>) -> Result<(), CodecError> {
    // SAFETY: `sample` is a valid sample buffer for the duration of the callback.
    let block = unsafe { sample.data_buffer() }
        .ok_or_else(|| CodecError::Backend("encoded sample has no data".into()))?;
    // SAFETY: As above; the block buffer is retained.
    let length = unsafe { block.data_length() };
    slot.data.clear();
    slot.data.resize(length, 0);
    let Some(destination) = std::ptr::NonNull::new(slot.data.as_mut_ptr()) else {
        return Ok(());
    };
    // SAFETY: The destination holds exactly `length` writable bytes.
    let status = unsafe { block.copy_data_bytes(0, length, destination.cast()) };
    cf::check(status, "copy encoded bytes")?;
    slot.key = is_sync(sample);
    // SAFETY: Sample timing accessors have no preconditions on a valid sample.
    slot.pts_us = cf::us_from_time(unsafe { sample.presentation_time_stamp() });
    slot.duration_us = cf::us_from_time(unsafe { sample.duration() });
    slot.description = match (slot.key, atom) {
        (true, Some(atom)) => description(sample, atom),
        _ => None,
    };
    Ok(())
}

/// A sample is a sync (key) frame unless its attachments say `NotSync`.
fn is_sync(sample: &CMSampleBuffer) -> bool {
    // SAFETY: Read-only attachment lookup on a valid sample.
    let Some(array) = (unsafe { sample.sample_attachments_array(false) }) else {
        return true;
    };
    if array.count() < 1 {
        return true;
    }
    // SAFETY: Index 0 exists; each element is a CFDictionary per CoreMedia.
    let attachments = unsafe { array.value_at_index(0) }.cast::<CFDictionary>();
    let Some(attachments) = (unsafe { attachments.as_ref() }) else {
        return true;
    };
    // SAFETY: Key lookups return borrowed (+0) values or null.
    let value =
        unsafe { attachments.value((kCMSampleAttachmentKey_NotSync as *const CFString).cast()) };
    let Some(value) = (unsafe { value.cast::<CFType>().as_ref() }) else {
        return true;
    };
    !value
        .downcast_ref::<CFBoolean>()
        .is_some_and(CFBoolean::as_bool)
}

/// The `avcC`/`hvcC` record VideoToolbox keeps in the format description.
fn description(sample: &CMSampleBuffer, atom: &str) -> Option<Vec<u8>> {
    // SAFETY: Read-only lookups on a valid sample's format description.
    let format = unsafe { sample.format_description() }?;
    let atoms =
        unsafe { format.extension(kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) }?;
    let atoms = atoms.downcast_ref::<CFDictionary>()?;
    let key = CFString::from_str(atom);
    // SAFETY: Borrowed (+0) lookup.
    let value = unsafe { atoms.value((&*key as *const CFString).cast()) };
    let value = unsafe { value.cast::<CFType>().as_ref() }?;
    Some(value.downcast_ref::<CFData>()?.to_vec())
}
