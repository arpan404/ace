// SPDX-License-Identifier: Apache-2.0
//! A fake VA driver behind the [`Api`] table, for tests on machines without a GPU. It keeps
//! surfaces' bytes (so uploads read back), copies every buffer at render time, and answers
//! coded buffers with the bytes a test chooses.
#![allow(clippy::unwrap_used)]
use super::api::Api;
use super::device::Device;
use super::ffi::*;
use crate::select;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_uint, c_void};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Rendered {
    pub target: u32,
    pub buffers: Vec<(i32, Vec<u8>)>,
}

impl Rendered {
    pub fn kinds(&self) -> Vec<i32> {
        self.buffers.iter().map(|(k, _)| *k).collect()
    }
    /// The `n`th buffer of `kind`, read as `T`.
    pub fn get<T: Copy>(&self, kind: i32, n: usize) -> T {
        let (_, bytes) = self
            .buffers
            .iter()
            .filter(|(k, _)| *k == kind)
            .nth(n)
            .unwrap();
        assert!(bytes.len() >= std::mem::size_of::<T>());
        // SAFETY: the bytes were copied from a `T` (or a misc header and `T`) at render time.
        unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<T>()) }
    }
    pub fn bytes(&self, kind: i32, n: usize) -> &[u8] {
        &self
            .buffers
            .iter()
            .filter(|(k, _)| *k == kind)
            .nth(n)
            .unwrap()
            .1
    }
}

/// `(profile, entrypoint, attributes)` of each config created.
pub type ConfigRecord = (i32, i32, Vec<(i32, u32)>);

pub struct Fake {
    pub profiles: Vec<(i32, Vec<i32>)>,
    /// `(profile, entrypoint, attribute)` → value; absent ones are not supported.
    pub attributes: HashMap<(i32, i32, i32), u32>,
    pub refuse_configs: Vec<(i32, i32)>,
    pub fail_render: bool,
    pub surface_attributes: Vec<(i32, i32)>,
    /// What the "driver" writes to every coded buffer.
    pub coded: Vec<u8>,
    pub configs: Vec<ConfigRecord>,
    pub surfaces_created: usize,
    pub imports: Vec<VADRMPRIMESurfaceDescriptor>,
    pub rendered: Vec<Rendered>,
    pub terminated: bool,
    next_id: u32,
    surfaces: HashMap<u32, Vec<u8>>,
    buffers: HashMap<u32, (i32, Vec<u8>)>,
    images: HashMap<u32, u32>,
    open: Option<Rendered>,
    segment: Box<VACodedBufferSegment>,
}

// SAFETY: the raw pointers in `segment` point into `buffers`, owned by the same value and
// only touched under the Mutex.
unsafe impl Send for Fake {}

impl Default for Fake {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            attributes: HashMap::new(),
            refuse_configs: Vec::new(),
            fail_render: false,
            surface_attributes: Vec::new(),
            coded: vec![0, 0, 0, 1, 0x65, 0x88, 0x84],
            configs: Vec::new(),
            surfaces_created: 0,
            imports: Vec::new(),
            rendered: Vec::new(),
            terminated: false,
            next_id: 1,
            surfaces: HashMap::new(),
            buffers: HashMap::new(),
            images: HashMap::new(),
            open: None,
            segment: Box::new(VACodedBufferSegment {
                size: 0,
                bit_offset: 0,
                status: 0,
                reserved: 0,
                buf: std::ptr::null_mut(),
                next: std::ptr::null_mut(),
                va_reserved: [0; 4],
            }),
        }
    }
}

impl Fake {
    /// An Intel-like driver: H.264 High and HEVC Main encode on both entrypoints, VPP,
    /// JPEG decode and encode, CBR/VBR/CQP, packed sequence/picture/slice headers.
    pub fn intel() -> Self {
        use select::{entrypoint as e, packed, profile as p, rc};
        let mut fake = Self {
            profiles: vec![
                (p::NONE, vec![e::VIDEO_PROC]),
                (p::H264_HIGH, vec![e::VLD, e::ENC_SLICE, e::ENC_SLICE_LP]),
                (p::H264_MAIN, vec![e::VLD, e::ENC_SLICE, e::ENC_SLICE_LP]),
                (p::HEVC_MAIN, vec![e::VLD, e::ENC_SLICE_LP]),
                (p::JPEG_BASELINE, vec![e::VLD, e::ENC_PICTURE]),
            ],
            surface_attributes: vec![
                (
                    surface_attrib::MEMORY_TYPE,
                    (VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2 | 1) as i32,
                ),
                (surface_attrib::MAX_WIDTH, 4096),
                (surface_attrib::MAX_HEIGHT, 4096),
            ],
            ..Default::default()
        };
        for (profile, entrypoints) in fake.profiles.clone() {
            for entrypoint in entrypoints {
                let a = &mut fake.attributes;
                a.insert((profile, entrypoint, attrib::RT_FORMAT), 0x1 | 0x20000);
                a.insert(
                    (profile, entrypoint, attrib::RATE_CONTROL),
                    rc::CBR | rc::VBR | rc::CQP,
                );
                a.insert(
                    (profile, entrypoint, attrib::ENC_PACKED_HEADERS),
                    packed::SEQUENCE | packed::PICTURE | packed::SLICE | packed::MISC,
                );
                a.insert((profile, entrypoint, attrib::MAX_PICTURE_WIDTH), 4096);
                a.insert((profile, entrypoint, attrib::MAX_PICTURE_HEIGHT), 4096);
            }
        }
        fake
    }

    fn id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }
}

pub type Shared = Arc<Mutex<Fake>>;

thread_local! {
    static NEXT: RefCell<Option<Shared>> = const { RefCell::new(None) };
}

/// A device on the fake driver; the test keeps `Shared` to configure and inspect it.
pub fn device(fake: Fake) -> (Arc<Device>, Shared) {
    let shared = Arc::new(Mutex::new(fake));
    NEXT.with(|n| *n.borrow_mut() = Some(Arc::clone(&shared)));
    let fd = std::fs::File::open("/dev/null").unwrap();
    let device = Device::with_api(api(), fd.into(), "fake".into()).unwrap();
    (device, shared)
}

fn with<R>(dpy: VADisplay, f: impl FnOnce(&mut Fake) -> R) -> R {
    // SAFETY: every display handed out is `Arc::into_raw` of a `Mutex<Fake>`, alive until
    // `terminate`.
    let m = unsafe { &*(dpy as *const Mutex<Fake>) };
    f(&mut m.lock().unwrap())
}

unsafe extern "C" fn get_display_drm(_fd: c_int) -> VADisplay {
    let shared = NEXT.with(|n| n.borrow_mut().take()).unwrap();
    Arc::into_raw(shared) as VADisplay
}
unsafe extern "C" fn initialize(_: VADisplay, major: *mut c_int, minor: *mut c_int) -> VAStatus {
    // SAFETY: out-parameters from Device::with_api.
    unsafe {
        *major = 1;
        *minor = 17;
    }
    0
}
unsafe extern "C" fn terminate(dpy: VADisplay) -> VAStatus {
    with(dpy, |f| f.terminated = true);
    // SAFETY: the pointer came from Arc::into_raw in get_display_drm.
    drop(unsafe { Arc::from_raw(dpy as *const Mutex<Fake>) });
    0
}
unsafe extern "C" fn vendor(_: VADisplay) -> *const c_char {
    c"fake driver".as_ptr()
}
unsafe extern "C" fn max_profiles(_: VADisplay) -> c_int {
    32
}
unsafe extern "C" fn max_entrypoints(_: VADisplay) -> c_int {
    16
}
unsafe extern "C" fn query_profiles(
    dpy: VADisplay,
    out: *mut VAProfile,
    n: *mut c_int,
) -> VAStatus {
    with(dpy, |f| {
        for (i, (p, _)) in f.profiles.iter().enumerate() {
            // SAFETY: `out` has vaMaxNumProfiles (32) slots.
            unsafe { *out.add(i) = *p };
        }
        // SAFETY: out-parameter.
        unsafe { *n = f.profiles.len() as c_int };
    });
    0
}
unsafe extern "C" fn query_entrypoints(
    dpy: VADisplay,
    profile: VAProfile,
    out: *mut VAEntrypoint,
    n: *mut c_int,
) -> VAStatus {
    with(dpy, |f| {
        let list = f
            .profiles
            .iter()
            .find(|(p, _)| *p == profile)
            .map(|(_, e)| e.clone())
            .unwrap_or_default();
        for (i, e) in list.iter().enumerate() {
            // SAFETY: `out` has vaMaxNumEntrypoints (16) slots.
            unsafe { *out.add(i) = *e };
        }
        // SAFETY: out-parameter.
        unsafe { *n = list.len() as c_int };
    });
    0
}
unsafe extern "C" fn get_attributes(
    dpy: VADisplay,
    profile: VAProfile,
    entrypoint: VAEntrypoint,
    list: *mut VAConfigAttrib,
    n: c_int,
) -> VAStatus {
    with(dpy, |f| {
        for i in 0..n as usize {
            // SAFETY: `list` has `n` entries.
            let a = unsafe { &mut *list.add(i) };
            a.value = *f
                .attributes
                .get(&(profile, entrypoint, a.type_))
                .unwrap_or(&select::ATTRIB_NOT_SUPPORTED);
        }
    });
    0
}
unsafe extern "C" fn create_config(
    dpy: VADisplay,
    profile: VAProfile,
    entrypoint: VAEntrypoint,
    list: *mut VAConfigAttrib,
    n: c_int,
    id: *mut VAConfigID,
) -> VAStatus {
    with(dpy, |f| {
        if f.refuse_configs.contains(&(profile, entrypoint)) {
            return 0x12; // VA_STATUS_ERROR_UNSUPPORTED_ENTRYPOINT
        }
        let attribs = (0..n as usize)
            // SAFETY: `list` has `n` entries.
            .map(|i| unsafe { *list.add(i) })
            .map(|a| (a.type_, a.value))
            .collect();
        f.configs.push((profile, entrypoint, attribs));
        // SAFETY: out-parameter.
        unsafe { *id = f.id() };
        0
    })
}
unsafe extern "C" fn destroy_config(_: VADisplay, _: VAConfigID) -> VAStatus {
    0
}
unsafe extern "C" fn query_surface_attributes(
    dpy: VADisplay,
    _: VAConfigID,
    list: *mut VASurfaceAttrib,
    n: *mut c_uint,
) -> VAStatus {
    with(dpy, |f| {
        if !list.is_null() {
            for (i, (t, v)) in f.surface_attributes.iter().enumerate() {
                // SAFETY: the caller sized `list` from the first call.
                unsafe { *list.add(i) = VASurfaceAttrib::int(*t, *v) };
            }
        }
        // SAFETY: out-parameter.
        unsafe { *n = f.surface_attributes.len() as c_uint };
    });
    0
}
#[allow(clippy::too_many_arguments)]
unsafe extern "C" fn create_surfaces(
    dpy: VADisplay,
    _format: c_uint,
    width: c_uint,
    height: c_uint,
    ids: *mut VASurfaceID,
    count: c_uint,
    attribs: *mut VASurfaceAttrib,
    n: c_uint,
) -> VAStatus {
    with(dpy, |f| {
        for i in 0..n as usize {
            // SAFETY: `attribs` has `n` entries; a descriptor pointer is valid for the call.
            let a = unsafe { *attribs.add(i) };
            if a.type_ == surface_attrib::EXTERNAL_BUFFER_DESCRIPTOR {
                let desc = unsafe { *(a.value.value.p as *const VADRMPRIMESurfaceDescriptor) };
                f.imports.push(desc);
            }
        }
        for i in 0..count as usize {
            let id = f.id();
            f.surfaces
                .insert(id, vec![0; (width * height * 4) as usize]);
            f.surfaces_created += 1;
            // SAFETY: `ids` has `count` slots.
            unsafe { *ids.add(i) = id };
        }
    });
    0
}
unsafe extern "C" fn destroy_surfaces(dpy: VADisplay, ids: *mut VASurfaceID, n: c_int) -> VAStatus {
    with(dpy, |f| {
        for i in 0..n as usize {
            // SAFETY: `ids` has `n` entries.
            f.surfaces.remove(&unsafe { *ids.add(i) });
        }
    });
    0
}
#[allow(clippy::too_many_arguments)]
unsafe extern "C" fn create_context(
    dpy: VADisplay,
    _: VAConfigID,
    _: c_int,
    _: c_int,
    _: c_int,
    _: *mut VASurfaceID,
    _: c_int,
    id: *mut VAContextID,
) -> VAStatus {
    with(dpy, |f| {
        // SAFETY: out-parameter.
        unsafe { *id = f.id() };
    });
    0
}
unsafe extern "C" fn destroy_context(_: VADisplay, _: VAContextID) -> VAStatus {
    0
}
unsafe extern "C" fn create_buffer(
    dpy: VADisplay,
    _: VAContextID,
    kind: VABufferType,
    size: c_uint,
    count: c_uint,
    data: *mut c_void,
    id: *mut VABufferID,
) -> VAStatus {
    with(dpy, |f| {
        let len = (size * count) as usize;
        let bytes = if data.is_null() {
            vec![0; len.max(64)]
        } else {
            // SAFETY: `data` points at `len` bytes for the call.
            unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }.to_vec()
        };
        let new = f.id();
        f.buffers.insert(new, (kind, bytes));
        // SAFETY: out-parameter.
        unsafe { *id = new };
    });
    0
}
unsafe extern "C" fn destroy_buffer(dpy: VADisplay, id: VABufferID) -> VAStatus {
    with(dpy, |f| f.buffers.remove(&id));
    0
}
unsafe extern "C" fn map_buffer(dpy: VADisplay, id: VABufferID, out: *mut *mut c_void) -> VAStatus {
    with(dpy, |f| {
        let coded = f.coded.clone();
        let Some((kind, bytes)) = f.buffers.get_mut(&id) else {
            return 0x7; // VA_STATUS_ERROR_INVALID_BUFFER
        };
        let p = if *kind == buffer::ENC_CODED {
            *bytes = coded;
            f.segment.size = bytes.len() as u32;
            f.segment.buf = bytes.as_mut_ptr().cast();
            (&mut *f.segment as *mut VACodedBufferSegment).cast()
        } else {
            bytes.as_mut_ptr().cast()
        };
        // SAFETY: out-parameter.
        unsafe { *out = p };
        0
    })
}
unsafe extern "C" fn unmap_buffer(_: VADisplay, _: VABufferID) -> VAStatus {
    0
}
unsafe extern "C" fn begin_picture(
    dpy: VADisplay,
    _: VAContextID,
    target: VASurfaceID,
) -> VAStatus {
    with(dpy, |f| {
        f.open = Some(Rendered {
            target,
            buffers: Vec::new(),
        })
    });
    0
}
unsafe extern "C" fn render_picture(
    dpy: VADisplay,
    _: VAContextID,
    ids: *mut VABufferID,
    n: c_int,
) -> VAStatus {
    with(dpy, |f| {
        if f.fail_render {
            return 0x1; // VA_STATUS_ERROR_OPERATION_FAILED
        }
        for i in 0..n as usize {
            // SAFETY: `ids` has `n` entries.
            let id = unsafe { *ids.add(i) };
            let entry = f.buffers.get(&id).cloned().unwrap();
            f.open.as_mut().unwrap().buffers.push(entry);
        }
        0
    })
}
unsafe extern "C" fn end_picture(dpy: VADisplay, _: VAContextID) -> VAStatus {
    with(dpy, |f| {
        if let Some(r) = f.open.take() {
            f.rendered.push(r);
        }
    });
    0
}
unsafe extern "C" fn sync_surface(_: VADisplay, _: VASurfaceID) -> VAStatus {
    0
}
unsafe extern "C" fn create_image(
    dpy: VADisplay,
    format: *mut VAImageFormat,
    width: c_int,
    height: c_int,
    out: *mut VAImage,
) -> VAStatus {
    with(dpy, |f| {
        // SAFETY: in- and out-parameters from Device::create_image.
        let format = unsafe { *format };
        let (w, h) = (width as u32, height as u32);
        let pitch = if format.bits_per_pixel == 12 {
            w.next_multiple_of(64)
        } else {
            w * 4
        };
        let size = if format.bits_per_pixel == 12 {
            pitch * h * 3 / 2
        } else {
            pitch * h
        };
        let buf = f.id();
        f.buffers
            .insert(buf, (buffer::IMAGE, vec![0; size as usize]));
        let image_id = f.id();
        f.images.insert(image_id, buf);
        let image = VAImage {
            image_id,
            format,
            buf,
            width: w as u16,
            height: h as u16,
            data_size: size,
            num_planes: if format.bits_per_pixel == 12 { 2 } else { 1 },
            pitches: [pitch, pitch, 0],
            offsets: [0, pitch * h, 0],
            ..Default::default()
        };
        // SAFETY: out-parameter.
        unsafe { *out = image };
    });
    0
}
unsafe extern "C" fn destroy_image(dpy: VADisplay, id: VAImageID) -> VAStatus {
    with(dpy, |f| {
        if let Some(buf) = f.images.remove(&id) {
            f.buffers.remove(&buf);
        }
    });
    0
}
#[allow(clippy::too_many_arguments)]
unsafe extern "C" fn put_image(
    dpy: VADisplay,
    surface: VASurfaceID,
    image: VAImageID,
    _: c_int,
    _: c_int,
    _: c_uint,
    _: c_uint,
    _: c_int,
    _: c_int,
    _: c_uint,
    _: c_uint,
) -> VAStatus {
    with(dpy, |f| {
        let data = f.buffers[&f.images[&image]].1.clone();
        f.surfaces.insert(surface, data);
    });
    0
}
unsafe extern "C" fn get_image(
    dpy: VADisplay,
    surface: VASurfaceID,
    _: c_int,
    _: c_int,
    _: c_uint,
    _: c_uint,
    image: VAImageID,
) -> VAStatus {
    with(dpy, |f| {
        let stored = f.surfaces[&surface].clone();
        let buf = f.images[&image];
        let target = &mut f.buffers.get_mut(&buf).unwrap().1;
        let n = target.len().min(stored.len());
        target[..n].copy_from_slice(&stored[..n]);
    });
    0
}
unsafe extern "C" fn error_str(_: VAStatus) -> *const c_char {
    c"fake error".as_ptr()
}

fn api() -> Api {
    Api {
        _libraries: Vec::new(),
        get_display_drm,
        initialize,
        terminate,
        query_vendor_string: vendor,
        max_num_profiles: max_profiles,
        max_num_entrypoints: max_entrypoints,
        query_config_profiles: query_profiles,
        query_config_entrypoints: query_entrypoints,
        get_config_attributes: get_attributes,
        create_config,
        destroy_config,
        query_surface_attributes,
        create_surfaces,
        destroy_surfaces,
        create_context,
        destroy_context,
        create_buffer,
        destroy_buffer,
        map_buffer,
        unmap_buffer,
        begin_picture,
        render_picture,
        end_picture,
        sync_surface,
        create_image,
        destroy_image,
        put_image,
        get_image,
        error_str,
    }
}
