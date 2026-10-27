use crate::errors::{Code, Error, Result};
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

pub fn create_staging(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    operation: &'static str,
) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    unsafe {
        let mut staging = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut staging))
            .map_err(|e| Error::from(e).context(operation))?;
        staging.ok_or_else(|| Error::new(Code::Internal, "D3D11 returned no resource"))
    }
}

pub fn copy_to_rgb(
    context: &ID3D11DeviceContext,
    staging: &ID3D11Texture2D,
    rgb: &mut [u8],
    width: u32,
    height: u32,
) -> Result<()> {
    let width_usz = width as usize;
    let height_usz = height as usize;
    let expected = width_usz
        .checked_mul(height_usz)
        .and_then(|v| v.checked_mul(3))
        .ok_or_else(|| Error::new(Code::Bounds, "Invalid capture size"))?;
    if rgb.len() < expected {
        return Err(Error::new(Code::Internal, "RGB buffer too small"));
    }
    unsafe {
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let result = copy_mapped(&mapped, rgb, width_usz, height_usz);
        context.Unmap(staging, 0);
        result
    }
}

unsafe fn copy_mapped(
    mapped: &D3D11_MAPPED_SUBRESOURCE,
    rgb: &mut [u8],
    width: usize,
    height: usize,
) -> Result<()> {
    if mapped.pData.is_null() {
        return Err(Error::new(Code::Internal, "D3D11 mapped no data"));
    }
    let row_bytes = width
        .checked_mul(4)
        .ok_or_else(|| Error::new(Code::Bounds, "Invalid capture size"))?;
    if (mapped.RowPitch as usize) < row_bytes {
        return Err(Error::new(Code::Internal, "D3D11 row pitch too small"));
    }
    let pitch = mapped.RowPitch as usize;
    for y in 0..height {
        let row = std::slice::from_raw_parts((mapped.pData as *const u8).add(y * pitch), row_bytes);
        for x in 0..width {
            let dst = (y * width + x) * 3;
            rgb[dst..dst + 3].copy_from_slice(&[row[x * 4 + 2], row[x * 4 + 1], row[x * 4]]);
        }
    }
    Ok(())
}
