// SPDX-License-Identifier: Apache-2.0
//! The shared D3D11 device: created with video support and multithread protection, and
//! handed to MFTs through an `IMFDXGIDeviceManager`.
use super::com::{Ctx, Runtime};
use crate::Vendor;
use media_codec::CodecError;
use std::sync::Arc;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_FLAG, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
    D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    ID3D11VideoContext, ID3D11VideoDevice,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1,
};
use windows::Win32::Media::MediaFoundation::{IMFDXGIDeviceManager, MFCreateDXGIDeviceManager};
use windows_core::Interface;

/// The adapter behind the device: the key the ranking cache uses (ADR 0148), and whether it
/// is Microsoft's software rasteriser.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Adapter {
    pub vendor: Vendor,
    pub device_id: u32,
    pub luid: u64,
    /// The user-mode driver version DXGI reports, when it reports one.
    pub driver_version: Option<u64>,
    pub description: String,
    /// The Basic Render Driver or another adapter DXGI flags as software.
    pub software: bool,
}

pub(crate) struct Inner {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub video: Option<(ID3D11VideoDevice, ID3D11VideoContext)>,
    pub manager: IMFDXGIDeviceManager,
    pub adapter: Adapter,
    _runtime: Runtime,
}
// SAFETY: The device is free-threaded. The immediate context is not, but the device is
// created multithread-protected (`ID3D11Multithread::SetMultithreadProtected(TRUE)`), so
// D3D11 serialises every context call, and the video context shares that lock. The DXGI
// device manager is documented as safe to share between threads.
unsafe impl Send for Inner {}
// SAFETY: As above.
unsafe impl Sync for Inner {}

/// A cloneable handle to the shared device.
#[derive(Clone)]
pub struct MfDevice(pub(crate) Arc<Inner>);

impl MfDevice {
    /// Opens the first adapter with `D3D11_CREATE_DEVICE_VIDEO_SUPPORT`. An adapter without
    /// video support still gives a device (for textures and copies) with no video processor.
    pub fn new() -> Result<Self, CodecError> {
        let runtime = Runtime::start()?;
        // SAFETY: Plain factory creation; the adapter index is checked by DXGI.
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ctx("CreateDXGIFactory1")?;
        let adapter = unsafe { factory.EnumAdapters1(0) }.ctx("EnumAdapters1")?;
        let flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        let (device, context) = create(&adapter, flags)
            .or_else(|_| create(&adapter, D3D11_CREATE_DEVICE_BGRA_SUPPORT))?;
        // SAFETY: `device` is a live device; the interfaces are queried, not assumed.
        let multithread: ID3D11Multithread = device.cast().ctx("ID3D11Multithread")?;
        let _ = unsafe { multithread.SetMultithreadProtected(true) };
        let video = device
            .cast::<ID3D11VideoDevice>()
            .and_then(|v| Ok((v, context.cast::<ID3D11VideoContext>()?)))
            .ok();
        let mut token = 0u32;
        let mut manager = None;
        // SAFETY: Out-pointers to locals; the manager is reset to our device before use.
        unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager) }
            .ctx("MFCreateDXGIDeviceManager")?;
        let manager = manager.ok_or_else(|| CodecError::Backend("no device manager".into()))?;
        unsafe { manager.ResetDevice(&device, token) }.ctx("ResetDevice")?;
        Ok(Self(Arc::new(Inner {
            adapter: describe(&adapter)?,
            device,
            context,
            video,
            manager,
            _runtime: runtime,
        })))
    }

    pub fn adapter(&self) -> &Adapter {
        &self.0.adapter
    }

    /// Whether the device has a D3D11 video processor (colour conversion and scaling).
    pub fn has_video(&self) -> bool {
        self.0.video.is_some()
    }

    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

fn create(
    adapter: &IDXGIAdapter1,
    flags: D3D11_CREATE_DEVICE_FLAG,
) -> Result<(ID3D11Device, ID3D11DeviceContext), CodecError> {
    let levels: [D3D_FEATURE_LEVEL; 4] = [
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    ];
    let mut device = None;
    let mut context = None;
    // SAFETY: An explicit adapter needs `D3D_DRIVER_TYPE_UNKNOWN` and no software module.
    unsafe {
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            flags,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .ctx("D3D11CreateDevice")?;
    match (device, context) {
        (Some(device), Some(context)) => Ok((device, context)),
        _ => Err(CodecError::Backend(
            "D3D11CreateDevice returned nothing".into(),
        )),
    }
}

fn describe(adapter: &IDXGIAdapter1) -> Result<Adapter, CodecError> {
    // SAFETY: Reads a plain descriptor struct.
    let desc = unsafe { adapter.GetDesc1() }.ctx("GetDesc1")?;
    let end = desc.Description.iter().position(|c| *c == 0).unwrap_or(128);
    let luid =
        (u64::from(desc.AdapterLuid.HighPart as u32) << 32) | u64::from(desc.AdapterLuid.LowPart);
    // SAFETY: Documented way to read the UMD version; failure only means "not reported".
    let driver_version = unsafe { adapter.CheckInterfaceSupport(&IDXGIDevice::IID) }
        .ok()
        .map(|v| v as u64);
    let vendor = Vendor(desc.VendorId);
    Ok(Adapter {
        vendor,
        device_id: desc.DeviceId,
        luid,
        driver_version,
        description: String::from_utf16_lossy(&desc.Description[..end]),
        software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0
            || vendor == Vendor::MICROSOFT,
    })
}
