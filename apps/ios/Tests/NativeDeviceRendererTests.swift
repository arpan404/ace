import CoreVideo
import Foundation
import Testing
@testable import Ace

@Suite struct NativeDeviceRendererTests {
    @Test func aLiveDeviceDecodesItsFramesAndRequestsAKeyframeAfterCorruption() async throws {
        let (description, encoded) = try H264DecodeTests.encode(width: 320, height: 240, frames: 2)
        let avc = try AVCDescription(description)
        let key = DeviceH264Tests.annexB(prefix: avc.sequenceParameterSets + avc.pictureParameterSets, lengthPrefixed: encoded[0], lengthSize: avc.nalLengthSize)
        let delta = DeviceH264Tests.annexB(prefix: [], lengthPrefixed: encoded[1], lengthSize: avc.nalLengthSize)
        let recorder = DeviceRenderRecorder()
        let renderer = NativeDeviceRenderer(deviceId: "android:phone", present: recorder.present, acknowledge: recorder.acknowledge)
        defer { renderer.close() }
        // Another device, and JPEG stills, cannot affect the live decoder.
        renderer.receive(chunk(device: "android:other", seq: 1, key: true, bytes: key))
        var still = chunk(seq: 1, key: true, bytes: key); still.still = true
        renderer.receive(still)
        renderer.receive(chunk(seq: 1, key: false, bytes: delta))
        try await wait { recorder.acks.count == 1 }
        #expect(recorder.sizes.isEmpty)
        #expect(recorder.acks.first?.keyframe == true)
        renderer.receive(chunk(seq: 2, key: true, bytes: key))
        renderer.receive(chunk(seq: 3, key: false, bytes: delta))
        try await wait { recorder.acks.count == 3 }
        #expect(recorder.sizes == [CGSize(width: 320, height: 240), CGSize(width: 320, height: 240)])
        #expect(recorder.acks.map(\.sequence) == [1, 2, 3])
        #expect(recorder.acks.suffix(2).allSatisfy { !$0.keyframe })
        renderer.receive(chunk(seq: 4, key: true, bytes: Data([0, 0, 1, 0x65, 1])))
        try await wait { recorder.acks.count == 4 }
        #expect(recorder.acks.last?.keyframe == true)
        renderer.receive(chunk(seq: 5, key: true, bytes: key))
        try await wait { recorder.acks.count == 5 }
        #expect(recorder.sizes.count == 3)
        #expect(recorder.acks.last?.keyframe == false)
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
