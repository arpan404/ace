// SPDX-License-Identifier: Apache-2.0
//! Opens the NVIDIA driver's libraries at run time. Nothing is linked: without the driver, or
//! with one older than the pinned NVENC version, there is simply no backend.
#![allow(unsafe_code)]
use crate::dec_abi::{CudaFns, CuvidFns};
use crate::enc_abi::{
    self, CreateInstance, FUNCTION_LIST_VER, FunctionList, MAX_SUPPORTED_AT_LEAST,
    MaxSupportedVersion,
};
use crate::error::{missing, nvenc};
use libloading::Library;
use media_codec::CodecError;
use std::sync::Arc;

#[cfg(target_os = "linux")]
mod names {
    pub const ENCODE: &str = "libnvidia-encode.so.1";
    pub const CUVID: &str = "libnvcuvid.so.1";
    pub const CUDA: &str = "libcuda.so.1";
}
#[cfg(windows)]
mod names {
    pub const ENCODE: &str = "nvEncodeAPI64.dll";
    pub const CUVID: &str = "nvcuvid.dll";
    pub const CUDA: &str = "nvcuda.dll";
}

/// NVENC's function table and the library that owns it.
pub struct EncodeApi {
    pub list: FunctionList,
    _library: Option<Library>,
}

/// CUDA's driver entry points and the library that owns them.
pub struct CudaApi {
    pub fns: CudaFns,
    _library: Option<Library>,
}

/// NVDEC's entry points and the library that owns them.
pub struct CuvidApi {
    pub fns: CuvidFns,
    _library: Option<Library>,
}

// SAFETY (the three impls): the tables are written once at load and only read after; the
// driver's entry points may be called from any thread, each on handles one owner uses at a time.
unsafe impl Send for EncodeApi {}
unsafe impl Sync for EncodeApi {}
unsafe impl Send for CudaApi {}
unsafe impl Sync for CudaApi {}
unsafe impl Send for CuvidApi {}
unsafe impl Sync for CuvidApi {}

impl EncodeApi {
    /// A table that isn't backed by a library: the tests' fake driver.
    #[cfg(test)]
    pub fn from_list(list: FunctionList) -> Self {
        Self {
            list,
            _library: None,
        }
    }
}
impl CudaApi {
    #[cfg(test)]
    pub fn from_fns(fns: CudaFns) -> Self {
        Self {
            fns,
            _library: None,
        }
    }
}
impl CuvidApi {
    #[cfg(test)]
    pub fn from_fns(fns: CuvidFns) -> Self {
        Self {
            fns,
            _library: None,
        }
    }
}

/// The driver's libraries, as far as this machine has them.
#[derive(Clone, Default)]
pub struct NvRuntime {
    pub(crate) encode: Option<Arc<EncodeApi>>,
    pub(crate) cuda: Option<Arc<CudaApi>>,
    pub(crate) cuvid: Option<Arc<CuvidApi>>,
    /// Why a part is missing, for `ace doctor`.
    pub(crate) missing: Vec<String>,
}

impl NvRuntime {
    /// Opens whatever of NVENC, CUDA and NVDEC the driver provides. Never fails: a part that
    /// can't be opened is absent and its reason is kept.
    pub fn load() -> Self {
        let mut runtime = Self::default();
        match load_encode() {
            Ok(api) => runtime.encode = Some(Arc::new(api)),
            Err(e) => runtime.missing.push(e.to_string()),
        }
        match load_cuda() {
            Ok(api) => runtime.cuda = Some(Arc::new(api)),
            Err(e) => runtime.missing.push(e.to_string()),
        }
        match load_cuvid() {
            Ok(api) => runtime.cuvid = Some(Arc::new(api)),
            Err(e) => runtime.missing.push(e.to_string()),
        }
        runtime
    }
    /// NVENC at the pinned version or newer.
    pub fn has_encode(&self) -> bool {
        self.encode.is_some()
    }
    /// NVDEC and the CUDA context it needs.
    pub fn has_decode(&self) -> bool {
        self.cuda.is_some() && self.cuvid.is_some()
    }
    /// Why parts are absent: library not found, or a driver older than the pinned version.
    pub fn missing(&self) -> &[String] {
        &self.missing
    }
}

fn open(name: &str) -> Result<Library, CodecError> {
    // SAFETY: the NVIDIA driver libraries run no initialisers with preconditions on the
    // loading thread; loading them is what NVIDIA documents for applications.
    unsafe { Library::new(name) }
        .map_err(|e| CodecError::Unsupported(format!("{name} not loadable: {e}")))
}

/// Copies a function pointer of type `T` out of `library`. The pointer stays valid as long as
/// the library is loaded, which its owner guarantees by holding it.
fn symbol<T: Copy>(library: &Library, name: &str) -> Result<T, CodecError> {
    let mut bytes = name.as_bytes().to_vec();
    bytes.push(0);
    // SAFETY: each call site names `T` as the documented signature of `name`.
    unsafe { library.get::<T>(&bytes) }
        .map(|s| *s)
        .map_err(|_| missing(name))
}

/// `(major << 4) | minor` against the pinned version.
pub fn version_supported(reported: u32) -> bool {
    reported >= MAX_SUPPORTED_AT_LEAST
}

fn load_encode() -> Result<EncodeApi, CodecError> {
    let library = open(names::ENCODE)?;
    let max: MaxSupportedVersion = symbol(&library, "NvEncodeAPIGetMaxSupportedVersion")?;
    let mut reported = 0u32;
    // SAFETY: documented signature; writes one u32.
    nvenc("NvEncodeAPIGetMaxSupportedVersion", unsafe {
        max(&mut reported)
    })?;
    if !version_supported(reported) {
        return Err(CodecError::Unsupported(format!(
            "NVIDIA driver offers NVENC {}.{}, ace needs {}.{}",
            reported >> 4,
            reported & 0xf,
            enc_abi::API_MAJOR,
            enc_abi::API_MINOR
        )));
    }
    let create: CreateInstance = symbol(&library, "NvEncodeAPICreateInstance")?;
    let mut list: FunctionList = enc_abi::zeroed();
    list.version = FUNCTION_LIST_VER;
    // SAFETY: the table is ours, zeroed, with its version set; the driver fills the slots.
    nvenc("NvEncodeAPICreateInstance", unsafe { create(&mut list) })?;
    Ok(EncodeApi {
        list,
        _library: Some(library),
    })
}

fn load_cuda() -> Result<CudaApi, CodecError> {
    let library = open(names::CUDA)?;
    let fns = CudaFns {
        init: symbol(&library, "cuInit")?,
        device_get: symbol(&library, "cuDeviceGet")?,
        ctx_create: symbol(&library, "cuCtxCreate_v2")?,
        ctx_destroy: symbol(&library, "cuCtxDestroy_v2")?,
        ctx_push: symbol(&library, "cuCtxPushCurrent_v2")?,
        ctx_pop: symbol(&library, "cuCtxPopCurrent_v2")?,
        memcpy_2d: symbol(&library, "cuMemcpy2D_v2")?,
    };
    Ok(CudaApi {
        fns,
        _library: Some(library),
    })
}

fn load_cuvid() -> Result<CuvidApi, CodecError> {
    let library = open(names::CUVID)?;
    let fns = CuvidFns {
        get_decoder_caps: symbol(&library, "cuvidGetDecoderCaps")?,
        create_decoder: symbol(&library, "cuvidCreateDecoder")?,
        destroy_decoder: symbol(&library, "cuvidDestroyDecoder")?,
        decode_picture: symbol(&library, "cuvidDecodePicture")?,
        create_parser: symbol(&library, "cuvidCreateVideoParser")?,
        parse_data: symbol(&library, "cuvidParseVideoData")?,
        destroy_parser: symbol(&library, "cuvidDestroyVideoParser")?,
        map_frame: symbol(&library, "cuvidMapVideoFrame64")?,
        unmap_frame: symbol(&library, "cuvidUnmapVideoFrame64")?,
    };
    Ok(CuvidApi {
        fns,
        _library: Some(library),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_driver_older_than_the_pinned_version_is_refused() {
        assert!(version_supported(12 << 4));
        assert!(version_supported((13 << 4) | 1));
        assert!(!version_supported((11 << 4) | 1));
    }

    #[test]
    fn a_machine_without_the_driver_has_no_backend_and_says_why() {
        // The build containers and CI have no NVIDIA driver.
        let runtime = NvRuntime::load();
        if runtime.has_encode() || runtime.has_decode() {
            return; // a real NVIDIA host
        }
        assert_eq!(runtime.missing().len(), 3);
        assert!(runtime.missing()[0].contains(names::ENCODE));
    }
}
