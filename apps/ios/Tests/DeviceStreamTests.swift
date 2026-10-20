import Foundation
import Testing
@testable import Ace

/// Device pictures (stream kind 4, ADR 0064 "Shared media stream") read natively. The golden
/// pieces below were written by the daemon's own encoder (`encodePicture` in
/// `@ace/browser`'s `stream-picture.ts`), so these tests hold the Swift reader to the daemon's wire.
@Suite struct DeviceStreamTests {
    /// An iOS simulator's JPEG: sequence 7, 1179 × 2556 at scale 3, rotated 90°, sent without the
    /// keyframe flag (every JPEG is one anyway).
    static let jpeg = "41434553010400510000000b0000005500000000401c0000000000004097710000000000049b09fc40400000005a00046a7065670028696f733a30413142324333442d344535462d363037312d383239332d41344235433644374538463900056361702d31ffd8ffd9"
    /// An Android emulator's H.264 keyframe: 1080 × 2400 at scale 2.625, rotated 270°, Annex B
    /// with its SPS (4-byte start code) and PPS (3-byte start code) in front of the slice.
    static let keyframe = "41434553010400450000000c0000005b00000000000000000000000040000000000000000438096040280000010e010b617663312e3432453031460015616e64726f69643a656d756c61746f722d3535353400056361702d32000000016742e01f00000168ce3c8000000001658884"

    @Test func aSimulatorJPEGFromTheDaemonReadsWithItsSizeScaleRotationAndBytes() throws {
        var router = BinaryRouter()
        guard case .device(let frame) = router.route(try hex(Self.jpeg)) else { Issue.record("no device frame"); return }
        #expect(frame == DeviceFrameChunk(
            deviceId: "ios:0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9", streamId: "cap-1", sequence: 7, timestamp: 1500.25,
            width: 1179, height: 2556, scale: 3, rotation: .quarter, codec: "jpeg", key: true,
            bytes: Data([0xff, 0xd8, 0xff, 0xd9])))
    }

    @Test func anEmulatorH264KeyframeCarriesItsParameterSetsInAnnexB() throws {
        var router = BinaryRouter()
        guard case .device(let frame) = router.route(try hex(Self.keyframe)) else { Issue.record("no device frame"); return }
        #expect(frame.deviceId == "android:emulator-5554" && frame.streamId == "cap-2")
        #expect(frame.codec == "avc1.42E01F" && frame.key && !frame.isJPEG)
        #expect(frame.width == 1080 && frame.height == 2400 && frame.rotation == .threeQuarters)
        // The f32 on the wire reads back as the scale the daemon meant.
        #expect(frame.scale == 2.625)
        let sets = try #require(AnnexB.parameterSets(frame.bytes))
        #expect(sets.sequence == [Data([0x67, 0x42, 0xe0, 0x1f])])
        #expect(sets.picture == [Data([0x68, 0xce, 0x3c, 0x80])])
        #expect(try AnnexB.lengthPrefixed(frame.bytes) == Data([0, 0, 0, 3, 0x65, 0x88, 0x84]))
    }

    @Test func aDevicePictureCutIntoPiecesIsAssembledOnceItsLastPieceArrives() throws {
        let golden = try hex(Self.jpeg)
        let meta = golden.subdata(in: 20..<(20 + 81))
        var payload = Data([0xff, 0xd8])
        payload.append(Data((0..<150_000).map { UInt8($0 % 251) }))
        let pieces = BrowserStreamTests.pieces(kind: StreamWire.Kind.deviceFrame, id: 5, meta: meta, payload: payload)
        #expect(pieces.count == 3)
        var router = BinaryRouter()
        #expect(router.route(pieces[0]) == BinaryRouter.Outcome.none)
        #expect(router.route(pieces[1]) == BinaryRouter.Outcome.none)
        guard case .device(let frame) = router.route(pieces[2]) else { Issue.record("no device frame"); return }
        #expect(frame.bytes == payload)
        #expect(frame.sequence == 7 && frame.width == 1179)
    }

    @Test func devicePicturesAndBrowserVideoShareOneSocketsRouter() throws {
        var router = BinaryRouter()
        guard case .device = router.route(try hex(Self.jpeg)) else { Issue.record("no device frame"); return }
        guard case .stream = router.route(try hex(BrowserStreamTests.keyframe)) else { Issue.record("no browser video"); return }
        // A kind this build doesn't know (audio, or one a newer daemon adds) is skipped, not fatal.
        let audio = BrowserStreamTests.pieces(kind: 3, id: 9, meta: Data([0, 1]), payload: Data([1]))[0]
        #expect(router.route(audio) == BinaryRouter.Outcome.none)
        guard case .device = router.route(try hex(Self.keyframe)) else { Issue.record("no device frame"); return }
    }

    @Test func malformedDevicePictureHeadersBreakTheConnection() throws {
        let golden = try hex(Self.jpeg)
        /// The golden piece with header bytes replaced, at offsets into the header.
        func patched(_ changes: [Int: [UInt8]]) -> Data {
            var piece = golden
            for (at, bytes) in changes { piece.replaceSubrange((20 + at)..<(20 + at + bytes.count), with: bytes) }
            return piece
        }
        let malformed: [(String, Data)] = [
            ("a rotation that isn't a quarter turn", patched([24: [0, 45]])),
            ("a zero width", patched([16: [0, 0]])),
            ("a zero scale", patched([20: [0, 0, 0, 0]])),
            ("a fractional sequence", patched([0: [0x3f, 0xe0, 0, 0, 0, 0, 0, 0]])),
            ("a codec that is neither JPEG nor H.264", patched([28: Array("vp08".utf8)])),
            ("a source that isn't a device id", patched([34: Array("mac".utf8)])),
            ("a stream id outside the capture id alphabet", patched([76: Array("!".utf8)])),
        ]
        for (reason, piece) in malformed {
            var router = BinaryRouter()
            #expect(router.route(piece) == .broken, "\(reason)")
        }
        let meta = golden.subdata(in: 20..<(20 + 81))
        let reshaped: [(String, Data, Data)] = [
            ("a header longer than its fields", meta + Data([0]), Data([1])),
            ("a header cut short", meta.prefix(30), Data([1])),
            ("a picture with no bytes", meta, Data()),
        ]
        for (reason, meta, payload) in reshaped {
            var router = BinaryRouter()
            let piece = BrowserStreamTests.pieces(kind: StreamWire.Kind.deviceFrame, id: 1, meta: meta, payload: payload)[0]
            #expect(router.route(piece) == .broken, "\(reason)")
        }
    }

    private func hex(_ text: String) throws -> Data {
        var data = Data()
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            data.append(try #require(UInt8(text[index..<next], radix: 16)))
            index = next
        }
        return data
    }
}
