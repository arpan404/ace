// SPDX-License-Identifier: Apache-2.0
//! The libva entry points, resolved at run time from `libva.so.2` and `libva-drm.so.2`.
//! The table is also the seam tests replace with a fake driver.
use super::ffi::*;
use std::ffi::{c_char, c_int, c_uint, c_void};

type Dpy = VADisplay;

/// Function pointers into libva. `_libraries` keeps the shared objects mapped for as long as
/// any pointer may be called.
pub struct Api {
    pub(crate) _libraries: Vec<libloading::Library>,
    pub get_display_drm: unsafe extern "C" fn(c_int) -> Dpy,
    pub initialize: unsafe extern "C" fn(Dpy, *mut c_int, *mut c_int) -> VAStatus,
    pub terminate: unsafe extern "C" fn(Dpy) -> VAStatus,
    pub query_vendor_string: unsafe extern "C" fn(Dpy) -> *const c_char,
    pub max_num_profiles: unsafe extern "C" fn(Dpy) -> c_int,
    pub max_num_entrypoints: unsafe extern "C" fn(Dpy) -> c_int,
    pub query_config_profiles: unsafe extern "C" fn(Dpy, *mut VAProfile, *mut c_int) -> VAStatus,
    pub query_config_entrypoints:
        unsafe extern "C" fn(Dpy, VAProfile, *mut VAEntrypoint, *mut c_int) -> VAStatus,
    pub get_config_attributes:
        unsafe extern "C" fn(Dpy, VAProfile, VAEntrypoint, *mut VAConfigAttrib, c_int) -> VAStatus,
    pub create_config: unsafe extern "C" fn(
        Dpy,
        VAProfile,
        VAEntrypoint,
        *mut VAConfigAttrib,
        c_int,
        *mut VAConfigID,
    ) -> VAStatus,
    pub destroy_config: unsafe extern "C" fn(Dpy, VAConfigID) -> VAStatus,
    pub query_surface_attributes:
        unsafe extern "C" fn(Dpy, VAConfigID, *mut VASurfaceAttrib, *mut c_uint) -> VAStatus,
    pub create_surfaces: unsafe extern "C" fn(
        Dpy,
        c_uint,
        c_uint,
        c_uint,
        *mut VASurfaceID,
        c_uint,
        *mut VASurfaceAttrib,
        c_uint,
    ) -> VAStatus,
    pub destroy_surfaces: unsafe extern "C" fn(Dpy, *mut VASurfaceID, c_int) -> VAStatus,
    pub create_context: unsafe extern "C" fn(
        Dpy,
        VAConfigID,
        c_int,
        c_int,
        c_int,
        *mut VASurfaceID,
        c_int,
        *mut VAContextID,
    ) -> VAStatus,
    pub destroy_context: unsafe extern "C" fn(Dpy, VAContextID) -> VAStatus,
    pub create_buffer: unsafe extern "C" fn(
        Dpy,
        VAContextID,
        VABufferType,
        c_uint,
        c_uint,
        *mut c_void,
        *mut VABufferID,
    ) -> VAStatus,
    pub destroy_buffer: unsafe extern "C" fn(Dpy, VABufferID) -> VAStatus,
    pub map_buffer: unsafe extern "C" fn(Dpy, VABufferID, *mut *mut c_void) -> VAStatus,
    pub unmap_buffer: unsafe extern "C" fn(Dpy, VABufferID) -> VAStatus,
    pub begin_picture: unsafe extern "C" fn(Dpy, VAContextID, VASurfaceID) -> VAStatus,
    pub render_picture: unsafe extern "C" fn(Dpy, VAContextID, *mut VABufferID, c_int) -> VAStatus,
    pub end_picture: unsafe extern "C" fn(Dpy, VAContextID) -> VAStatus,
    pub sync_surface: unsafe extern "C" fn(Dpy, VASurfaceID) -> VAStatus,
    pub create_image:
        unsafe extern "C" fn(Dpy, *mut VAImageFormat, c_int, c_int, *mut VAImage) -> VAStatus,
    pub destroy_image: unsafe extern "C" fn(Dpy, VAImageID) -> VAStatus,
    pub put_image: unsafe extern "C" fn(
        Dpy,
        VASurfaceID,
        VAImageID,
        c_int,
        c_int,
        c_uint,
        c_uint,
        c_int,
        c_int,
        c_uint,
        c_uint,
    ) -> VAStatus,
    pub get_image:
        unsafe extern "C" fn(Dpy, VASurfaceID, c_int, c_int, c_uint, c_uint, VAImageID) -> VAStatus,
    pub error_str: unsafe extern "C" fn(VAStatus) -> *const c_char,
}

/// Why libva couldn't be used.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoadError {
    /// No `libva.so.2` or `libva-drm.so.2` on this machine: no VA backend, not an error.
    Missing(String),
    /// The libraries exist but lack an entry point this backend needs (libva older than 2.1).
    Symbol(String),
}

macro_rules! resolve {
    ($lib:expr, $name:literal) => {{
        // SAFETY: the symbol is declared in `va.h` with exactly the field's signature, and
        // the library stays loaded in `Api::_libraries` while the pointer is used.
        let symbol = unsafe { $lib.get(concat!($name, "\0").as_bytes()) }
            .map_err(|e| LoadError::Symbol(format!("{}: {e}", $name)))?;
        *symbol
    }};
}

impl Api {
    /// Opens libva. Never panics: a missing library is [`LoadError::Missing`].
    pub fn load() -> Result<Self, LoadError> {
        // SAFETY: loading runs the libraries' initialisers; libva's only set up its own
        // state and are safe to run on any thread.
        let va = unsafe { libloading::Library::new("libva.so.2") }
            .map_err(|e| LoadError::Missing(e.to_string()))?;
        // SAFETY: as above.
        let drm = unsafe { libloading::Library::new("libva-drm.so.2") }
            .map_err(|e| LoadError::Missing(e.to_string()))?;
        Ok(Self {
            get_display_drm: resolve!(drm, "vaGetDisplayDRM"),
            initialize: resolve!(va, "vaInitialize"),
            terminate: resolve!(va, "vaTerminate"),
            query_vendor_string: resolve!(va, "vaQueryVendorString"),
            max_num_profiles: resolve!(va, "vaMaxNumProfiles"),
            max_num_entrypoints: resolve!(va, "vaMaxNumEntrypoints"),
            query_config_profiles: resolve!(va, "vaQueryConfigProfiles"),
            query_config_entrypoints: resolve!(va, "vaQueryConfigEntrypoints"),
            get_config_attributes: resolve!(va, "vaGetConfigAttributes"),
            create_config: resolve!(va, "vaCreateConfig"),
            destroy_config: resolve!(va, "vaDestroyConfig"),
            query_surface_attributes: resolve!(va, "vaQuerySurfaceAttributes"),
            create_surfaces: resolve!(va, "vaCreateSurfaces"),
            destroy_surfaces: resolve!(va, "vaDestroySurfaces"),
            create_context: resolve!(va, "vaCreateContext"),
            destroy_context: resolve!(va, "vaDestroyContext"),
            create_buffer: resolve!(va, "vaCreateBuffer"),
            destroy_buffer: resolve!(va, "vaDestroyBuffer"),
            map_buffer: resolve!(va, "vaMapBuffer"),
            unmap_buffer: resolve!(va, "vaUnmapBuffer"),
            begin_picture: resolve!(va, "vaBeginPicture"),
            render_picture: resolve!(va, "vaRenderPicture"),
            end_picture: resolve!(va, "vaEndPicture"),
            sync_surface: resolve!(va, "vaSyncSurface"),
            create_image: resolve!(va, "vaCreateImage"),
            destroy_image: resolve!(va, "vaDestroyImage"),
            put_image: resolve!(va, "vaPutImage"),
            get_image: resolve!(va, "vaGetImage"),
            error_str: resolve!(va, "vaErrorStr"),
            _libraries: vec![va, drm],
        })
    }
}
