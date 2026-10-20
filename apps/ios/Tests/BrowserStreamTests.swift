import Foundation
import Testing
@testable import Ace

/// The live browser's binary stream (ADR 0088), read natively. The golden pieces below were
/// written by the daemon's own encoder (`@ace/browser/stream`), so these tests hold the Swift
/// reader to the wire the daemon sends.
@Suite struct BrowserStreamTests {
    static let frame = "4143455301010029000000070000002d00000000404500000000000040934a0000000000000001860000034c00087468726561642d3100057461622d32ffd8ffd9"
    static let keyframe = "414345530102004d00000008000000530000000040220000000000004058c00000000000000001860000034c049209e4010b617663312e34324530333300110142e033ffe100046742e03301000268ce00087468726561642d3100057461622d32000000026588"
    static let delta = "4143455301020037000000090000003d0000000040240000000000004060800000000000000001860000034c049209e4000b617663312e343245303333000000087468726561642d31000000000002419a"
    static let download = "414345530108001e0000000a00000021000000000000000000000000400800000000000000087468726561642d3100026431010203"

    @Test func aJPEGFrameFromTheDaemonReadsWithItsSizeTabAndBytes() throws {
        var router = BinaryRouter()
        guard case .stream(.frame(let frame)) = router.route(try bytes(Self.frame)) else { Issue.record("no frame"); return }
        #expect(frame == BrowserJPEGFrame(threadId: "thread-1", sequence: 42, timestamp: 1234.5, width: 390, height: 844,
                                          tabId: "tab-2", bytes: Data([0xff, 0xd8, 0xff, 0xd9])))
    }

    @Test func aVideoKeyframeCarriesItsDecoderDescriptionAndADeltaDoesNot() throws {
        var router = BinaryRouter()
        guard case .stream(.video(let key)) = router.route(try bytes(Self.keyframe)),
              case .stream(.video(let delta)) = router.route(try bytes(Self.delta)) else { Issue.record("no video"); return }
        #expect(key.key && !delta.key)
        #expect(key.sequence == 9 && delta.sequence == 10)
        #expect(key.codec == "avc1.42E033")
        #expect(key.codedWidth == 1170 && key.codedHeight == 2532 && key.width == 390 && key.height == 844)
        #expect(key.tabId == "tab-2" && delta.tabId == nil)
        #expect(key.bytes == Data([0, 0, 0, 2, 0x65, 0x88]))
        let avc = try AVCDescription(try #require(key.description))
        #expect(avc.nalLengthSize == 4)
        #expect(avc.sequenceParameterSets == [Data([0x67, 0x42, 0xe0, 0x33])])
        #expect(avc.pictureParameterSets == [Data([0x68, 0xce])])
        #expect(delta.description == nil)
    }

    @Test func downloadsAndOtherBinaryChannelsAreNotDrawn() throws {
        var router = BinaryRouter()
        #expect(router.route(try bytes(Self.download)) == BinaryRouter.Outcome.none)
        // Not a stream piece at all: the SDK's own binary channel reads it.
        #expect(router.route(Data("{\"type\":\"x\"}".utf8)) == .sdk)
        // The router still reads the next message whole.
        guard case .stream(.frame) = router.route(try bytes(Self.frame)) else { Issue.record("no frame"); return }
    }

    @Test func aMessageCutIntoPiecesIsAssembledOnceItsLastPieceArrives() throws {
        let payload = Data((0..<150_000).map { UInt8($0 % 251) })
        let pieces = Self.pieces(kind: 1, id: 3, meta: try frameMeta(), payload: payload)
        #expect(pieces.count == 3)
        #expect(pieces.allSatisfy { $0.count <= StreamWire.pieceBytes })
        var router = BinaryRouter()
        #expect(router.route(pieces[0]) == BinaryRouter.Outcome.none)
        #expect(router.route(pieces[1]) == BinaryRouter.Outcome.none)
        guard case .stream(.frame(let frame)) = router.route(pieces[2]) else { Issue.record("no frame"); return }
        #expect(frame.bytes == payload)
        #expect(frame.sequence == 42)
    }

    @Test func aNewMessageReplacesOneItsSenderGaveUpOn() throws {
        let first = Self.pieces(kind: 1, id: 1, meta: try frameMeta(), payload: Data(repeating: 1, count: 100_000))
        var router = BinaryRouter()
        #expect(router.route(first[0]) == BinaryRouter.Outcome.none)
        guard case .stream(.frame) = router.route(try bytes(Self.frame)) else { Issue.record("no frame"); return }
    }

    @Test func malformedPiecesBreakTheConnection() throws {
        var outOfOrder = BinaryRouter()
        let pieces = Self.pieces(kind: 1, id: 1, meta: try frameMeta(), payload: Data(repeating: 1, count: 100_000))
        #expect(outOfOrder.route(pieces[1]) == .broken)

        var version = try bytes(Self.frame)
        version[4] = 2
        var router = BinaryRouter()
        #expect(router.route(version) == .broken)

        // A JPEG frame whose page size is outside the protocol's bounds.
        var small = try bytes(Self.frame)
        small[20 + 16 + 2] = 0; small[20 + 16 + 3] = 50
        #expect(router.route(small) == .broken)

        // Pieces never exceed 64 KiB.
        var oversized = Self.pieces(kind: 1, id: 1, meta: try frameMeta(), payload: Data(count: 10))[0]
        oversized.append(Data(count: StreamWire.pieceBytes))
        #expect(router.route(oversized) == .broken)
    }

    @Test func aDecoderDescriptionWithoutParameterSetsIsRefused() {
        #expect(throws: AVCDescription.ParseError.noParameterSets) {
            try AVCDescription(Data([1, 0x42, 0xe0, 0x33, 0xff, 0xe0, 0]))
        }
        #expect(throws: AVCDescription.ParseError.short) {
            try AVCDescription(Data([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0, 9, 0x67]))
        }
    }

    // MARK: - Video gate

    @Test func deltasBeforeTheFirstKeyframeAreSkippedThenTheKeyframeConfiguresTheDecoder() throws {
        var router = BinaryRouter()
        guard case .stream(.video(let key)) = router.route(try bytes(Self.keyframe)),
              case .stream(.video(let delta)) = router.route(try bytes(Self.delta)) else { Issue.record("no video"); return }
        var gate = VideoChunkGate()
        #expect(gate.admit(delta) == .skip)
        let config = VideoDecoderConfig(codec: "avc1.42E033", codedWidth: 1170, codedHeight: 2532, description: key.description)
        #expect(gate.admit(key) == .decode(configure: config))
        #expect(gate.admit(delta) == .decode(configure: nil))
        // The same keyframe again (the periodic one) keeps the decoder.
        #expect(gate.admit(key) == .decode(configure: nil))
    }

    @Test func aDecodeErrorAsksForAKeyframeAtTheNewestChunkAndSkipsUntilOne() throws {
        var router = BinaryRouter()
        guard case .stream(.video(let key)) = router.route(try bytes(Self.keyframe)),
              case .stream(.video(let delta)) = router.route(try bytes(Self.delta)) else { Issue.record("no video"); return }
        var gate = VideoChunkGate()
        _ = gate.admit(key)
        _ = gate.admit(delta)
        #expect(gate.failed() == 10)
        #expect(gate.admit(delta) == .skip)
        #expect(gate.admit(key) != .skip)
        // A reset (a JPEG frame, a new tab) forgets everything: nothing to ask a keyframe for.
        gate.reset()
        #expect(gate.failed() == nil)
    }

    // MARK: - Helpers

    private func bytes(_ hex: String) throws -> Data {
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            data.append(try #require(UInt8(hex[index..<next], radix: 16)))
            index = next
        }
        return data
    }
    /// The golden frame's header.
    private func frameMeta() throws -> Data {
        let frame = try bytes(Self.frame)
        return frame.subdata(in: 20..<(20 + 41))
    }
    /// A message cut into socket-sized pieces as the envelope's spec describes.
    static func pieces(kind: UInt8, id: UInt32, meta: Data, payload: Data) -> [Data] {
        let body = meta + payload
        let room = StreamWire.pieceBytes - StreamWire.prefixBytes
        var pieces: [Data] = []
        var offset = 0
        repeat {
            let size = min(room, body.count - offset)
            var piece = Data()
            func u32(_ value: UInt32) { piece.append(contentsOf: [UInt8(value >> 24 & 0xff), UInt8(value >> 16 & 0xff), UInt8(value >> 8 & 0xff), UInt8(value & 0xff)]) }
            u32(StreamWire.magic)
            piece.append(contentsOf: [1, kind, UInt8(meta.count >> 8), UInt8(meta.count & 0xff)])
            u32(id); u32(UInt32(body.count)); u32(UInt32(offset))
            piece.append(body.subdata(in: offset..<(offset + size)))
            pieces.append(piece)
            offset += size
        } while offset < body.count
        return pieces
    }
}
