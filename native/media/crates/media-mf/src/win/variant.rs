// SPDX-License-Identifier: Apache-2.0
//! Plain-value VARIANTs for `ICodecAPI` and WIC property bags.
use std::mem::ManuallyDrop;
use windows::Win32::Foundation::VARIANT_BOOL;
use windows::Win32::System::Variant::{
    VARENUM, VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_R4, VT_UI4, VT_UI8,
};

fn make(vt: VARENUM, value: VARIANT_0_0_0) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: value,
            }),
        },
    }
}

pub(crate) fn u32(value: u32) -> VARIANT {
    make(VT_UI4, VARIANT_0_0_0 { ulVal: value })
}
pub(crate) fn u64(value: u64) -> VARIANT {
    make(VT_UI8, VARIANT_0_0_0 { ullVal: value })
}
pub(crate) fn bool(value: bool) -> VARIANT {
    make(
        VT_BOOL,
        VARIANT_0_0_0 {
            boolVal: VARIANT_BOOL(if value { -1 } else { 0 }),
        },
    )
}
pub(crate) fn f32(value: f32) -> VARIANT {
    make(VT_R4, VARIANT_0_0_0 { fltVal: value })
}
