import CoreVideo
import Foundation
import Testing
@testable import Ace

/// A device's H.264 arrives in Annex B with its parameter sets in front of each keyframe and no
/// `avcC`: the decoder configures from those sets and decodes real VideoToolbox frames.
@Suite struct DeviceH264Tests {
    @Test func nalUnitsAreReadBetweenThreeAndFourByteStartCodes() {
        let stream = Data([0x09, 0x10, // not a NAL unit: before the first start code
                           0, 0, 0, 1, 0x67, 0x42, 0x00, 0x03, // a zero inside a unit is kept
                           0, 0, 1, 0x68, 0xce,
                           0, 0, 0, 1, 0x65, 0x88, 0, 0]) // trailing zeros aren't the unit's
        #expect(AnnexB.nalUnits(stream) == [Data([0x67, 0x42, 0x00, 0x03]), Data([0x68, 0xce]), Data([0x65, 0x88])])
    }

    @Test func aKeyframeNeedsBothParameterSetsToConfigureADecoder() {
        let noPicture = Data([0, 0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x65, 0x88])
        #expect(AnnexB.parameterSets(noPicture) == nil)
        #expect(throws: H264Decoder.DecodeError.self) { try H264Decoder(annexBKeyframe: noPicture) }
        // A unit made only of parameter sets has no picture to decode.
        #expect(throws: AnnexB.ParseError.noNALUnits) { try AnnexB.lengthPrefixed(Data([0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x68, 0xce])) }
    }

    @Test func anAnnexBKeyframeAndTheDeltaAfterItDecodeAtTheirSize() throws {
        let (record, chunks) = try H264DecodeTests.encode(width: 320, height: 240, frames: 2)
        let avc = try AVCDescription(record)
        let sets = avc.sequenceParameterSets + avc.pictureParameterSets
        let keyframe = Self.annexB(prefix: sets, lengthPrefixed: chunks[0], lengthSize: avc.nalLengthSize)
        let delta = Self.annexB(prefix: [], lengthPrefixed: chunks[1], lengthSize: avc.nalLengthSize)
        let decoder = try H264Decoder(annexBKeyframe: keyframe)
        #expect(decoder.parameterSets == sets)
        for unit in [keyframe, delta] {
            let picture = try decoder.decode(annexB: unit)
            #expect(CVPixelBufferGetWidth(picture) == 320)
            #expect(CVPixelBufferGetHeight(picture) == 240)
        }
    }

    /// Rewrites an AVC-format access unit as Annex B, its parameter sets first, alternating
    /// four- and three-byte start codes as encoders do.
    static func annexB(prefix sets: [Data], lengthPrefixed unit: Data, lengthSize: Int) -> Data {
        var units = sets
        let reader = ByteReader(unit)
        var at = 0
        while at + lengthSize <= reader.count {
            var length = 0
            for index in 0..<lengthSize { length = length << 8 | Int(reader.u8(at + index)) }
            units.append(reader.slice(at + lengthSize, length))
            at += lengthSize + length
        }
        var out = Data()
        for (index, nal) in units.enumerated() {
            out.append(contentsOf: index.isMultiple(of: 2) ? [0, 0, 0, 1] : [0, 0, 1])
            out.append(nal)
        }
        return out
    }
}
