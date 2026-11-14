// SPDX-License-Identifier: Apache-2.0
//! Which encoder MFT to open first. Pure: the Windows side feeds it what `MFTEnumEx` listed.
//!
//! Hardware MFTs come before software ones. Among hardware MFTs, the one made by the vendor
//! of the D3D11 device's adapter comes first, since only it can take that device's textures;
//! otherwise `MFTEnumEx`'s own `MFT_ENUM_FLAG_SORTANDFILTER` order stands. On an NVIDIA
//! adapter the NVIDIA MFT is therefore the deterministic first choice (ADR 0148); replacing
//! it with NVENC is the ranking benchmark's decision (`ace-media`'s `rank.rs`), never this
//! crate's.

/// A PCI vendor, from `MFT_ENUM_HARDWARE_VENDOR_ID_Attribute` (`"VEN_10DE"`) or a DXGI
/// adapter description.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vendor(pub u32);
impl Vendor {
    pub const NVIDIA: Self = Self(0x10de);
    pub const AMD: Self = Self(0x1002);
    pub const INTEL: Self = Self(0x8086);
    pub const QUALCOMM: Self = Self(0x4d4f_4351);
    /// Microsoft's Basic Render Driver (WARP): no hardware video.
    pub const MICROSOFT: Self = Self(0x1414);

    /// Parses `VEN_xxxx` (hex), as MFTs report it.
    pub fn from_mft(text: &str) -> Option<Self> {
        let hex = text.trim().strip_prefix("VEN_")?;
        u32::from_str_radix(hex, 16).ok().map(Self)
    }
}

/// One MFT as listed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub name: String,
    pub hardware: bool,
    pub vendor: Option<Vendor>,
}

/// Indices into `listed`, in the order to try them.
pub fn order_encoders(listed: &[Candidate], adapter: Option<Vendor>) -> Vec<usize> {
    let rank = |c: &Candidate| match (c.hardware, c.vendor.is_some() && c.vendor == adapter) {
        (true, true) => 0,
        (true, false) => 1,
        (false, _) => 2,
    };
    let mut order: Vec<usize> = (0..listed.len()).collect();
    // Stable: equal ranks keep MFTEnumEx's order.
    order.sort_by_key(|&i| rank(&listed[i]));
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mft(name: &str, hardware: bool, vendor: Option<Vendor>) -> Candidate {
        Candidate {
            name: name.into(),
            hardware,
            vendor,
        }
    }

    #[test]
    fn the_adapters_own_hardware_mft_comes_first_and_software_last() {
        let listed = [
            mft("software", false, None),
            mft("intel", true, Some(Vendor::INTEL)),
            mft("nvidia", true, Some(Vendor::NVIDIA)),
        ];
        assert_eq!(order_encoders(&listed, Some(Vendor::NVIDIA)), vec![2, 1, 0]);
        assert_eq!(order_encoders(&listed, Some(Vendor::INTEL)), vec![1, 2, 0]);
        // Without an adapter match, MFTEnumEx's order among hardware MFTs stands.
        assert_eq!(order_encoders(&listed, None), vec![1, 2, 0]);
        assert_eq!(
            order_encoders(&listed, Some(Vendor::MICROSOFT)),
            vec![1, 2, 0]
        );
    }

    #[test]
    fn a_machine_with_only_the_software_mft_still_has_an_encoder() {
        let listed = [mft("software", false, None)];
        assert_eq!(order_encoders(&listed, Some(Vendor::MICROSOFT)), vec![0]);
        assert!(order_encoders(&[], None).is_empty());
    }

    #[test]
    fn vendor_ids_parse_as_mfts_write_them() {
        assert_eq!(Vendor::from_mft("VEN_10DE"), Some(Vendor::NVIDIA));
        assert_eq!(Vendor::from_mft("VEN_8086"), Some(Vendor::INTEL));
        assert_eq!(Vendor::from_mft("10DE"), None);
        assert_eq!(Vendor::from_mft("VEN_XYZ"), None);
    }
}
