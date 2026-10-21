import CoreVideo
import Foundation
import Testing
import UIKit
@testable import Ace

@Suite struct NativeDeviceRendererTests {
    @Test func aLiveDeviceDecodesItsFramesAndRequestsAKeyframeAfterCorruption() async throws {
        let (description, encoded) = try H264DecodeTests.encode(width: 320, height: 240, frames: 2)
        let avc = try AVCDescription(description)
        let key = DeviceH264Tests.annexB(prefix: avc.sequenceParameterSets + avc.pictureParameterSets, lengthPrefixed: encoded[0], lengthSize: avc.nalLengthSize)
        let delta = DeviceH264Tests.annexB(prefix: [], lengthPrefixed: encoded[1], lengthSize: avc.nalLengthSize)
        let recorder = DeviceRenderRecorder()
        let renderer = NativeRemotePictureRenderer(deviceId: "android:phone", present: recorder.present, acknowledge: recorder.acknowledge)
        defer { renderer.close() }
        // Another device, and JPEG stills, cannot affect the live decoder.
        renderer.receiveVideo(chunk(device: "android:other", seq: 1, key: true, bytes: key))
        var still = chunk(seq: 1, key: true, bytes: key); still.still = true
        renderer.receiveVideo(still)
        renderer.receiveVideo(chunk(seq: 1, key: false, bytes: delta))
        try await wait { recorder.acks.count == 1 }
        #expect(recorder.sizes.isEmpty)
        #expect(recorder.acks.first?.keyframe == true)
        renderer.receiveVideo(chunk(seq: 2, key: true, bytes: key))
        renderer.receiveVideo(chunk(seq: 3, key: false, bytes: delta))
        try await wait { recorder.acks.count == 3 }
        #expect(recorder.sizes == [CGSize(width: 320, height: 240), CGSize(width: 320, height: 240)])
        #expect(recorder.acks.map(\.sequence) == [1, 2, 3])
        #expect(recorder.acks.suffix(2).allSatisfy { !$0.keyframe })
        renderer.receiveVideo(chunk(seq: 4, key: true, bytes: Data([0, 0, 1, 0x65, 1])))
        try await wait { recorder.acks.count == 4 }
        #expect(recorder.acks.last?.keyframe == true)
        renderer.receiveVideo(chunk(seq: 5, key: true, bytes: key))
        try await wait { recorder.acks.count == 5 }
        #expect(recorder.sizes.count == 3)
        #expect(recorder.acks.last?.keyframe == false)
    }
    @Test @MainActor func aMacSessionDecodesJPEGOnThePhoneAndIgnoresAnotherSessionsPictures() async throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 240), format: format).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 320, height: 240))
        }
        let bytes = try #require(image.jpegData(compressionQuality: 0.9))
        let frame = DeviceFrameChunk(deviceId: "screen-session", streamId: "jpeg-stream", sequence: 1, timestamp: 0,
                                     width: 320, height: 240, scale: 1, rotation: .none, codec: "jpeg", key: true, bytes: bytes)
        let decoded = try NativeJPEG.decode(frame)
        CVPixelBufferLockBaseAddress(decoded, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(decoded, .readOnly) }
        let base = try #require(CVPixelBufferGetBaseAddress(decoded))
        #expect(base.load(fromByteOffset: 2, as: UInt8.self) > 200)
        #expect(base.load(fromByteOffset: 0, as: UInt8.self) < 50)
        let recorder = DeviceRenderRecorder()
        let renderer = NativeRemotePictureRenderer(deviceId: "screen-session", present: recorder.present, acknowledge: recorder.acknowledge)
        defer { renderer.close() }
        renderer.receiveScreen(chunk(device: "other-session", seq: 1, key: true, bytes: bytes))
        renderer.receiveVideo(frame) // Device video never draws a JPEG fallback.
        renderer.receiveScreen(frame)
        try await wait { recorder.acks.count == 1 }
        #expect(recorder.sizes == [CGSize(width: 320, height: 240)])
        #expect(recorder.acks.first?.deviceId == "screen-session")
        #expect(recorder.acks.first?.keyframe == false)
    }
    private func chunk(device: String = "android:phone", seq: Int, key: Bool, bytes: Data) -> DeviceFrameChunk {
        DeviceFrameChunk(deviceId: device, streamId: "capture", sequence: seq, timestamp: 0, width: 320, height: 240, scale: 2, rotation: .none, codec: "avc1.42E033", key: key, bytes: bytes)
    }
    private func wait(_ predicate: () -> Bool) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("The device renderer did not acknowledge its frame")
    }
}
private final class DeviceRenderRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var pictures: [CGSize] = []
    private var acknowledgements: [NativeDeviceAck] = []
    var sizes: [CGSize] { lock.withLock { pictures } }
    var acks: [NativeDeviceAck] { lock.withLock { acknowledgements } }
    func present(_ picture: NativeDevicePicture) { lock.withLock { pictures.append(CGSize(width: CVPixelBufferGetWidth(picture.image), height: CVPixelBufferGetHeight(picture.image))) } }
    func acknowledge(_ ack: NativeDeviceAck) { lock.withLock { acknowledgements.append(ack) } }
}
