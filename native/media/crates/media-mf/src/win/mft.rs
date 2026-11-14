// SPDX-License-Identifier: Apache-2.0
//! Finding, opening and driving MFTs. Hardware MFTs are asynchronous: unlocked with
//! `MF_TRANSFORM_ASYNC_UNLOCK` and driven by `METransformNeedInput` / `METransformHaveOutput`
//! events. Software MFTs are synchronous and driven by `ProcessInput` / `ProcessOutput`
//! return codes. [`Transform`] hides the difference behind input credit and output polling.
use super::com::Ctx;
use super::device::MfDevice;
use crate::{Candidate, Vendor};
use media_codec::{CodecError, Size};
use std::time::{Duration, Instant};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows_core::{GUID, Interface, PWSTR};

pub(crate) struct Listed {
    pub activate: IMFActivate,
    pub candidate: Candidate,
}

/// `MFTEnumEx` for one input and output subtype: hardware MFTs, then synchronous software
/// ones, each in the system's `SORTANDFILTER` order.
pub(crate) fn list(category: GUID, input: GUID, output: GUID) -> Vec<Listed> {
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: input,
    };
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: output,
    };
    let mut out = Vec::new();
    for (flags, hardware) in [
        (MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, true),
        (MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER, false),
    ] {
        let mut array: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        // SAFETY: Out-pointers to locals; the array is ours to release with CoTaskMemFree.
        let listed = unsafe {
            MFTEnumEx(
                category,
                flags,
                Some(&input),
                Some(&output),
                &mut array,
                &mut count,
            )
        };
        if listed.is_err() || array.is_null() {
            continue;
        }
        for i in 0..count as usize {
            // SAFETY: `count` entries; each is moved out exactly once, then the array freed.
            let Some(activate) = (unsafe { array.add(i).read() }) else {
                continue;
            };
            let name = string(&activate, &MFT_FRIENDLY_NAME_Attribute).unwrap_or_default();
            let vendor = string(&activate, &MFT_ENUM_HARDWARE_VENDOR_ID_Attribute)
                .and_then(|v| Vendor::from_mft(&v));
            out.push(Listed {
                activate,
                candidate: Candidate {
                    name,
                    hardware,
                    vendor,
                },
            });
        }
        // SAFETY: Frees the array MFTEnumEx allocated; its entries were moved out above.
        unsafe { CoTaskMemFree(Some(array as *const _)) };
    }
    out
}

pub(crate) fn string(attributes: &IMFAttributes, key: &GUID) -> Option<String> {
    let mut text = PWSTR::null();
    let mut len = 0u32;
    // SAFETY: MF allocates the string; it is copied and freed here.
    unsafe { attributes.GetAllocatedString(key, &mut text, &mut len) }.ok()?;
    let value = unsafe { text.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(text.0 as *const _)) };
    value
}

/// A video media type of `subtype`, `size` and `fps`, progressive and square-pixelled.
pub(crate) fn video_type(subtype: GUID, size: Size, fps: u32) -> Result<IMFMediaType, CodecError> {
    // SAFETY: Attribute writes on a fresh media type.
    unsafe {
        let t = MFCreateMediaType().ctx("MFCreateMediaType")?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .ctx("major type")?;
        t.SetGUID(&MF_MT_SUBTYPE, &subtype).ctx("subtype")?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, pack(size.width, size.height))
            .ctx("frame size")?;
        if fps > 0 {
            t.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))
                .ctx("frame rate")?;
        }
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))
            .ctx("aspect")?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .ctx("interlace")?;
        Ok(t)
    }
}

/// BT.709, studio range: what the video processor writes.
pub(crate) fn tag_bt709(t: &IMFMediaType) -> Result<(), CodecError> {
    // SAFETY: Attribute writes on a media type we own.
    unsafe {
        t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)
            .ctx("matrix")?;
        t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)
            .ctx("range")?;
    }
    Ok(())
}

pub(crate) fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

pub(crate) fn unpack(value: u64) -> (u32, u32) {
    ((value >> 32) as u32, value as u32)
}

pub(crate) enum Output {
    Sample(IMFSample),
    /// The MFT needs input before it has more output.
    Empty,
    /// The output type changed; renegotiate and poll again.
    StreamChange,
}

pub(crate) struct Transform {
    pub mft: IMFTransform,
    activate: IMFActivate,
    events: Option<IMFMediaEventGenerator>,
    pub hardware: bool,
    pub name: String,
    /// The MFT took the D3D device manager.
    pub d3d: bool,
    need_input: u32,
    have_output: u32,
    drained: bool,
    provides_samples: bool,
    own_sample: Option<(IMFSample, u32)>,
    streaming: bool,
}
// SAFETY: MFTs are free-threaded COM objects in the MTA (`com.rs`); the async event queue
// is documented as callable from any thread. One owner drives each transform.
unsafe impl Send for Transform {}

impl Transform {
    /// Activates `listed`. Hardware MFTs are unlocked and, given a device, receive its
    /// manager; software MFTs get the device only when `software_d3d` and they say they're
    /// D3D11-aware.
    pub fn open(
        listed: &Listed,
        device: Option<&MfDevice>,
        software_d3d: bool,
    ) -> Result<Self, CodecError> {
        // SAFETY: Documented activation sequence; every interface is queried, not assumed.
        unsafe {
            let mft: IMFTransform = listed.activate.ActivateObject().ctx("ActivateObject")?;
            let attributes = mft.GetAttributes().ok();
            let is_async = attributes
                .as_ref()
                .and_then(|a| a.GetUINT32(&MF_TRANSFORM_ASYNC).ok())
                .is_some_and(|v| v != 0);
            let mut events = None;
            if is_async {
                let a = attributes.as_ref().ok_or(CodecError::NotConfigured)?;
                a.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                    .ctx("MF_TRANSFORM_ASYNC_UNLOCK")?;
                events = Some(
                    mft.cast::<IMFMediaEventGenerator>()
                        .ctx("event generator")?,
                );
            }
            if let Some(a) = &attributes {
                let _ = a.SetUINT32(&MF_LOW_LATENCY, 1);
            }
            let aware = attributes
                .as_ref()
                .and_then(|a| a.GetUINT32(&MF_SA_D3D11_AWARE).ok())
                .is_some_and(|v| v != 0);
            let mut d3d = false;
            if let Some(device) = device
                && (listed.candidate.hardware || (software_d3d && aware))
            {
                let manager = device.0.manager.as_raw() as usize;
                d3d = mft
                    .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager)
                    .is_ok();
                if listed.candidate.hardware && !d3d {
                    return Err(CodecError::Backend(
                        "hardware MFT refused the D3D11 device".into(),
                    ));
                }
            }
            Ok(Self {
                mft,
                activate: listed.activate.clone(),
                events,
                hardware: listed.candidate.hardware,
                name: listed.candidate.name.clone(),
                d3d,
                need_input: 0,
                have_output: 0,
                drained: false,
                provides_samples: false,
                own_sample: None,
                streaming: false,
            })
        }
    }

    /// After the types are set: start streaming.
    pub fn start(&mut self) -> Result<(), CodecError> {
        // SAFETY: Plain messages; types are set.
        unsafe {
            let info = self.mft.GetOutputStreamInfo(0).ctx("GetOutputStreamInfo")?;
            self.provides_samples = info.dwFlags
                & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0)
                    as u32
                != 0;
            self.mft
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .ctx("BEGIN_STREAMING")?;
            self.mft
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .ctx("START_OF_STREAM")?;
        }
        self.streaming = true;
        Ok(())
    }

    pub fn is_async(&self) -> bool {
        self.events.is_some()
    }

    /// Takes every queued event without waiting.
    pub fn pump(&mut self) -> Result<(), CodecError> {
        let Some(events) = &self.events else {
            return Ok(());
        };
        loop {
            // SAFETY: Non-blocking event read on the MFT's own queue.
            let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(event) => event,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                Err(e) => return Err(CodecError::Backend(format!("MFT event queue: {e}"))),
            };
            let kind = unsafe { event.GetType() }.ctx("event type")?;
            let status = unsafe { event.GetStatus() }.ctx("event status")?;
            let kind = MF_EVENT_TYPE(kind as i32);
            if kind == METransformNeedInput {
                self.need_input += 1;
            } else if kind == METransformHaveOutput {
                self.have_output += 1;
            } else if kind == METransformDrainComplete {
                self.drained = true;
            } else if kind == MEError || status.is_err() {
                return Err(CodecError::Backend(format!("MFT error event {status:?}")));
            }
        }
    }

    /// Whether `ProcessInput` may be called now.
    pub fn wants_input(&mut self) -> Result<bool, CodecError> {
        self.pump()?;
        Ok(!self.is_async() || self.need_input > 0)
    }

    /// Returns false when the MFT did not take the sample.
    pub fn input(&mut self, sample: &IMFSample) -> Result<bool, CodecError> {
        if !self.wants_input()? {
            return Ok(false);
        }
        // SAFETY: A complete sample for stream 0.
        match unsafe { self.mft.ProcessInput(0, sample, 0) } {
            Ok(()) => {
                self.need_input = self.need_input.saturating_sub(1);
                Ok(true)
            }
            Err(e) if e.code() == MF_E_NOTACCEPTING => Ok(false),
            Err(e) => Err(CodecError::Backend(format!("ProcessInput: {e}"))),
        }
    }

    /// One output, if the MFT has one. `capacity` sizes the sample this side provides when
    /// the MFT doesn't allocate its own.
    pub fn output(&mut self, capacity: u32) -> Result<Output, CodecError> {
        self.pump()?;
        if self.is_async() && self.have_output == 0 {
            return Ok(Output::Empty);
        }
        let sample = if self.provides_samples {
            None
        } else {
            Some(self.own_sample(capacity)?)
        };
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: std::mem::ManuallyDrop::new(sample),
            dwStatus: 0,
            pEvents: std::mem::ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        // SAFETY: One output buffer for stream 0; its sample and events are released below.
        let result = unsafe { self.mft.ProcessOutput(0, &mut buffers, &mut status) };
        let [mut buffer] = buffers;
        let sample = unsafe { std::mem::ManuallyDrop::take(&mut buffer.pSample) };
        unsafe { std::mem::ManuallyDrop::drop(&mut buffer.pEvents) };
        match result {
            Ok(()) => {
                self.have_output = self.have_output.saturating_sub(1);
                Ok(sample.map_or(Output::Empty, Output::Sample))
            }
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => {
                self.have_output = 0;
                Ok(Output::Empty)
            }
            Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                self.have_output = self.have_output.saturating_sub(1);
                Ok(Output::StreamChange)
            }
            Err(e) => Err(CodecError::Backend(format!("ProcessOutput: {e}"))),
        }
    }

    fn own_sample(&mut self, capacity: u32) -> Result<IMFSample, CodecError> {
        // SAFETY: Fresh MF objects; the buffer is attached to the sample once.
        unsafe {
            let info = self.mft.GetOutputStreamInfo(0).ctx("GetOutputStreamInfo")?;
            let size = info.cbSize.max(capacity);
            if let Some((sample, have)) = &self.own_sample
                && *have >= size
            {
                let buffer = sample.GetBufferByIndex(0).ctx("buffer")?;
                buffer.SetCurrentLength(0).ctx("SetCurrentLength")?;
                return Ok(sample.clone());
            }
            let sample = MFCreateSample().ctx("MFCreateSample")?;
            let buffer = MFCreateAlignedMemoryBuffer(size, info.cbAlignment.saturating_sub(1))
                .ctx("MFCreateAlignedMemoryBuffer")?;
            sample.AddBuffer(&buffer).ctx("AddBuffer")?;
            self.own_sample = Some((sample.clone(), size));
            Ok(sample)
        }
    }

    /// Asks for delayed output. Poll [`Self::output`] until [`Self::drained`].
    pub fn drain(&mut self) -> Result<(), CodecError> {
        self.drained = false;
        // SAFETY: Plain message.
        unsafe { self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0) }.ctx("COMMAND_DRAIN")
    }

    /// Async MFTs say so with `METransformDrainComplete`; sync ones by running dry.
    pub fn drained(&self) -> bool {
        self.drained
    }

    /// Waits up to `limit` for the async queue to change.
    pub fn wait(&mut self, limit: Duration) -> Result<(), CodecError> {
        let until = Instant::now() + limit;
        let before = (self.need_input, self.have_output, self.drained);
        while self.is_async() && Instant::now() < until {
            self.pump()?;
            if (self.need_input, self.have_output, self.drained) != before {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    }
}

impl Drop for Transform {
    fn drop(&mut self) {
        // SAFETY: Ends streaming and releases the MFT's resources as its activation documents.
        unsafe {
            if self.streaming {
                let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
            if self.d3d {
                let _ = self.mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, 0);
            }
            let _ = self.activate.ShutdownObject();
        }
    }
}

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

/// A sample holding `bytes` in system memory, timed in 100 ns units.
pub(crate) fn memory_sample(
    bytes: &[u8],
    pts_us: u64,
    duration_us: u64,
) -> Result<IMFSample, CodecError> {
    // SAFETY: Fresh buffer of `bytes.len()`, filled under its lock.
    unsafe {
        let buffer = MFCreateMemoryBuffer(bytes.len() as u32).ctx("MFCreateMemoryBuffer")?;
        let mut data = std::ptr::null_mut();
        buffer.Lock(&mut data, None, None).ctx("Lock")?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len());
        buffer.Unlock().ctx("Unlock")?;
        buffer
            .SetCurrentLength(bytes.len() as u32)
            .ctx("SetCurrentLength")?;
        timed_sample(&buffer, pts_us, duration_us)
    }
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
