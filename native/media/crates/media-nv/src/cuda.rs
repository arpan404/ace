// SPDX-License-Identifier: Apache-2.0
//! An owned CUDA context on the first GPU, through the driver API only (no CUDA toolkit).
#![allow(unsafe_code)]
use crate::dec_abi::CuContext;
use crate::error::cuda;
use crate::load::CudaApi;
use media_codec::CodecError;
use std::ptr::null_mut;
use std::sync::Arc;

pub struct CudaContext {
    pub api: Arc<CudaApi>,
    pub context: CuContext,
}

impl CudaContext {
    /// Creates the context and leaves no context current on this thread.
    pub fn create(api: Arc<CudaApi>) -> Result<Self, CodecError> {
        let fns = api.fns;
        // SAFETY (block): documented driver API signatures with out-pointers to our locals.
        unsafe {
            cuda("cuInit", (fns.init)(0))?;
            let mut device = 0;
            cuda("cuDeviceGet", (fns.device_get)(&mut device, 0))?;
            let mut context = null_mut();
            cuda("cuCtxCreate", (fns.ctx_create)(&mut context, 0, device))?;
            let owned = Self { api, context };
            let mut popped = null_mut();
            cuda("cuCtxPopCurrent", (fns.ctx_pop)(&mut popped))?;
            Ok(owned)
        }
    }

    /// Runs `f` with this context current, then makes it not current again.
    pub fn with<T>(&self, f: impl FnOnce() -> T) -> Result<T, CodecError> {
        let fns = self.api.fns;
        // SAFETY: the context is ours and alive; push and pop are paired.
        cuda("cuCtxPushCurrent", unsafe { (fns.ctx_push)(self.context) })?;
        let out = f();
        let mut popped = null_mut();
        // SAFETY: pops what was pushed above.
        cuda("cuCtxPopCurrent", unsafe { (fns.ctx_pop)(&mut popped) })?;
        Ok(out)
    }
}

impl Drop for CudaContext {
    fn drop(&mut self) {
        // SAFETY: the context is ours; nothing created on it outlives its owner.
        unsafe { (self.api.fns.ctx_destroy)(self.context) };
    }
}
