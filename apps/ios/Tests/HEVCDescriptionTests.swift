import Foundation
import Testing
@testable import Ace

@Suite struct HEVCDescriptionTests {
    private func record(_ arrays: [(UInt8, [Data])], lengthSize: UInt8 = 3) -> Data {
        var bytes = Data(repeating: 0, count: 23)
        bytes[0] = 1; bytes[21] = lengthSize; bytes[22] = UInt8(arrays.count)
        for (type, units) in arrays {
            bytes.append(contentsOf: [type | 128, UInt8(units.count >> 8), UInt8(units.count & 255)])
            for unit in units {
                bytes.append(contentsOf: [UInt8(unit.count >> 8), UInt8(unit.count & 255)])
                bytes.append(unit)
            }
        }
        return bytes
    }
    @Test func extractsAllParameterSetsInDecoderOrderAndSkipsOtherArrays() throws {
        let vps = Data([64, 1, 7]), sps = Data([66, 1, 8]), pps = Data([68, 1, 9])
        let bytes = record([(34, [pps]), (39, [Data([78, 1])]), (32, [vps, vps]), (33, [sps])])
        let parsed = try HEVCDescription(bytes)
        #expect(parsed.nalLengthSize == 4)
        #expect(parsed.parameterSets == [vps, vps, sps, pps])
        for length in 0..<bytes.count {
            #expect(throws: (any Error).self) { try HEVCDescription(bytes.prefix(length)) }
        }
        #expect(throws: (any Error).self) { try HEVCDescription(record([(32, [vps]), (33, [sps])])) }
        #expect(throws: (any Error).self) { try HEVCDescription(record([(32, [pps]), (33, [sps]), (34, [pps])])) }
    }
    @Test func advertisesHEVCOnlyForHardwareDecoders() {
        #expect(VideoCapabilities.decoders(hardwareHEVC: false) == ["avc1.42E033"])
        #expect(VideoCapabilities.decoders(hardwareHEVC: true) == ["hvc1.1.6.L153.B0", "avc1.42E033"])
    }
    @Test func annexBSeparatesHEVCConfigurationFromRandomAccessPictures() throws {
        let vps = Data([64, 1, 7]), sps = Data([66, 1, 8]), pps = Data([68, 1, 9])
        for type: UInt8 in [19, 20, 21] {
            let picture = Data([type << 1, 1, 5])
            let bytes = [vps, sps, pps, picture].reduce(into: Data()) { $0.append(contentsOf: [0, 0, 0, 1]); $0.append($1) }
            #expect(AnnexB.hevcParameterSets(bytes) == [vps, sps, pps])
            #expect(AnnexB.isHEVCKeyframe(picture))
            #expect(try AnnexB.hevcLengthPrefixed(bytes) == Data([0, 0, 0, 3]) + picture)
        }
    }
}
