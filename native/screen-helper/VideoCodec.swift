import Foundation
import CoreMedia

/// The video codecs the helper's hardware encoder runs. H.264 goes everywhere; HEVC goes only to
/// ace-media's ingest, which tells views that decode it apart from those that don't.
enum VideoCodec: Equatable {
    case h264
    case hevc

    var codecType: CMVideoCodecType { self == .h264 ? kCMVideoCodecType_H264 : kCMVideoCodecType_HEVC }
    /// The MediaFrame codec byte: Annex B either way.
    var mediaFrameCodec: UInt8 { self == .h264 ? MediaFrameCodec.h264AnnexB : MediaFrameCodec.hevcAnnexB }
    /// The WebCodecs string when the SPS can't be read: H.264 High 5.1, HEVC Main 5.1.
    var fallbackString: String { self == .h264 ? "avc1.640033" : "hvc1.1.6.L153.B0" }
}

/// The codec a stream configured as `configured` (`h264` or `hevc`) encodes in now: HEVC only
/// while its video goes to ace-media's ingest, H.264 on the daemon's socket.
func encodedCodec(configured: String, ingesting: Bool) -> VideoCodec {
    configured == "hevc" && ingesting ? .hevc : .h264
}

/// The codec a `stream.configure` runs: HEVC asked of a helper without a hardware HEVC encoder
/// runs as H.264.
func streamCodec(requested: String, hardwareHEVC: Bool) -> String {
    requested == "hevc" && !hardwareHEVC ? "h264" : requested
}

/// The NAL unit type of an HEVC NAL (ITU-T H.265 §7.3.1.2): 32 VPS, 33 SPS, 34 PPS.
func hevcNALType(_ first: UInt8) -> UInt8 { (first >> 1) & 0x3f }

/// The RBSP of a NAL payload: each emulation prevention byte (00 00 03) dropped.
private func rbsp(_ bytes: ArraySlice<UInt8>, limit: Int) -> [UInt8] {
    var out: [UInt8] = []
    out.reserveCapacity(limit)
    var zeros = 0
    for byte in bytes {
        if zeros >= 2, byte == 3 { zeros = 0; continue }
        out.append(byte)
        zeros = byte == 0 ? zeros + 1 : 0
        if out.count == limit { break }
    }
    return out
}

/// The WebCodecs string of an HEVC stream from its SPS NAL (header included), as ISO/IEC
/// 14496-15 Annex E builds it from `profile_tier_level`: `hvc1.` profile space letter and
/// profile, the compatibility flags in reverse bit order, tier and level, then the six
/// constraint bytes without trailing zeros. Nil for anything but a whole enough SPS.
func hevcCodecString(sps: [UInt8]) -> String? {
    guard sps.count >= 2, hevcNALType(sps[0]) == 33 else { return nil }
    // The first byte (VPS id, sub-layers, nesting), then 12 bytes of general profile, tier, level.
    let fields = rbsp(sps[2...], limit: 13)
    guard fields.count == 13 else { return nil }
    let space = fields[1] >> 6, tier = (fields[1] >> 5) & 1, profile = fields[1] & 0x1f
    let compatibility = fields[2...5].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    var reversed: UInt32 = 0
    for bit in 0..<32 where compatibility & (1 << UInt32(bit)) != 0 { reversed |= 1 << UInt32(31 - bit) }
    var constraints = Array(fields[6...11])
    while constraints.last == 0 { constraints.removeLast() }
    let spaceLetter = ["", "A", "B", "C"][Int(space)]
    var codec = "hvc1.\(spaceLetter)\(profile).\(String(reversed, radix: 16, uppercase: true)).\(tier == 1 ? "H" : "L")\(fields[12])"
    for byte in constraints { codec += "." + String(byte, radix: 16, uppercase: true) }
    return codec
}
