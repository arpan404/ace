import CoreMedia
import VideoToolbox

enum VideoCapabilities {
    static func decoders(hardwareHEVC: Bool) -> [String] {
        hardwareHEVC ? ["hvc1.1.6.L153.B0", "avc1.42E033"] : ["avc1.42E033"]
    }
    static var decoders: [String] { decoders(hardwareHEVC: VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC)) }
    static func isHEVC(_ codec: String) -> Bool { codec.hasPrefix("hvc1.") || codec.hasPrefix("hev1.") }
}
