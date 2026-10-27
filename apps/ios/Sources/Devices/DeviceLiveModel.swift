import CoreVideo
import Foundation
import Observation

struct NativeDevicePicture: @unchecked Sendable {
    let image: CVPixelBuffer
    let chunk: DeviceFrameChunk
}
struct NativeDeviceAck: Sendable {
    let deviceId: String
    let streamId: String
    let sequence: Int
    let keyframe: Bool
}
final class LatestDevicePicture: @unchecked Sendable {
    private let lock = NSLock()
    private var picture: NativeDevicePicture?
    func put(_ picture: NativeDevicePicture) { lock.withLock { self.picture = picture } }
    func take() -> NativeDevicePicture? { lock.withLock { defer { picture = nil }; return picture } }
}

/// One bounded decoding queue. Acknowledgement frees the host's window only after decode.
final class NativeRemotePictureRenderer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ace.remotePicture.render", qos: .userInteractive)
    private let deviceId: String
    private let present: @Sendable (NativeDevicePicture) -> Void
    private let acknowledge: @Sendable (NativeDeviceAck) -> Void
    private let sampler: StreamSampler?
    private var streamId: String?
    private var sequence = -1
    private var decoder: H264Decoder?
    private var closed = false
    init(deviceId: String, sampler: StreamSampler? = nil, present: @escaping @Sendable (NativeDevicePicture) -> Void, acknowledge: @escaping @Sendable (NativeDeviceAck) -> Void) {
        self.deviceId = deviceId; self.sampler = sampler; self.present = present; self.acknowledge = acknowledge
    }
    func receiveVideo(_ chunk: DeviceFrameChunk) {
        guard chunk.isLiveVideo else { return }
        receive(chunk)
    }
    func receiveScreen(_ chunk: DeviceFrameChunk) {
        guard !chunk.still else { return }
        receive(chunk)
    }
    private func receive(_ chunk: DeviceFrameChunk) {
        guard chunk.deviceId == deviceId else { return }
        sampler?.arrived(bytes: chunk.bytes.count)
        queue.async { [self] in
            guard !closed else { return }
            if streamId != chunk.streamId { streamId = chunk.streamId; sequence = -1; decoder = nil }
            guard chunk.sequence > sequence else { return }
            if sequence >= 0, chunk.sequence != sequence + 1, !chunk.key { decoder = nil }
            sequence = chunk.sequence
            var needsKeyframe = false
            do {
                if chunk.isJPEG {
                    present(NativeDevicePicture(image: try NativeJPEG.decode(chunk), chunk: chunk))
                    decoder = nil
                } else {
                    if chunk.key {
                        guard let sets = AnnexB.parameterSets(chunk.bytes) else { throw AnnexB.ParseError.noNALUnits }
                        if decoder?.parameterSets != sets.sequence + sets.picture { decoder = try H264Decoder(annexBKeyframe: chunk.bytes) }
                    }
                    if let decoder { present(NativeDevicePicture(image: try decoder.decode(annexB: chunk.bytes), chunk: chunk)) }
                    else { needsKeyframe = true }
                }
            } catch { decoder = nil; needsKeyframe = true }
            if needsKeyframe { sampler?.keyframeAsked() }
            acknowledge(NativeDeviceAck(deviceId: deviceId, streamId: chunk.streamId, sequence: chunk.sequence, keyframe: needsKeyframe))
        }
    }
    func close() { queue.async { [self] in closed = true; decoder = nil } }
}

@MainActor final class DeviceLiveModel {
    private var latest = LatestDevicePicture()
    private(set) var deviceId: String?
    private var renderer: NativeRemotePictureRenderer?
    private var streams: BrowserStreamHub?
    /// The stream's counts while its stats show (`StreamSampler`).
    let sampler = StreamSampler()
    func open(deviceId: String, session: any ClientSession) {
        close()
        self.deviceId = deviceId
        let latest = LatestDevicePicture()
        self.latest = latest
        let renderer = NativeRemotePictureRenderer(deviceId: deviceId, sampler: sampler, present: { latest.put($0) }) { ack in
            var value: [String: Any] = ["type": "devices.ack", "deviceId": ack.deviceId, "streamId": ack.streamId, "sequence": ack.sequence]
            if ack.keyframe { value["keyframe"] = true }
            ClientModel.action(value, to: session)
        }
        self.renderer = renderer; streams = session.browserStreams
        streams?.attachDevice { renderer.receiveVideo($0) }
    }
    func nextPicture() -> NativeDevicePicture? { latest.take() }
    func close(deviceId: String? = nil) {
        if let deviceId, deviceId != self.deviceId { return }
        self.deviceId = nil
        streams?.attachDevice(nil); streams = nil; renderer?.close(); renderer = nil
        _ = latest.take()
    }
}
