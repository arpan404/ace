import CoreGraphics
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
    var fallback = false
    /// The codec the decoder couldn't play, with `fallback`.
    var codec = ""
    /// The delivery generation the picture came for; nil before the script set one.
    var generation: Int?
}
final class LatestDevicePicture: @unchecked Sendable {
    private let lock = NSLock()
    private var picture: NativeDevicePicture?
    func put(_ picture: NativeDevicePicture) { lock.withLock { self.picture = picture } }
    func take() -> NativeDevicePicture? { lock.withLock { defer { picture = nil }; return picture } }
}

/// One bounded decoding queue. Acknowledgement frees the host's window only after decode. Each
/// picture is held to the source's current delivery (`DeliveryGate`) before it is decoded: one
/// that came another way is never drawn nor acknowledged, and a new delivery starts over.
final class NativeRemotePictureRenderer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ace.remotePicture.render", qos: .userInteractive)
    private let deviceId: String
    private let present: @Sendable (NativeDevicePicture) -> Void
    private let acknowledge: @Sendable (NativeDeviceAck) -> Void
    /// The decoded picture not yet drawn is let go when the delivery starts over.
    private let discard: @Sendable () -> Void
    private let sampler: StreamSampler?
    private let clock: @Sendable () -> TimeInterval
    private var gate = DeliveryGate<DeviceFrameChunk>()
    private var streamId: String?
    private var sequence = -1
    private var decoder: VideoDecoder?
    private var closed = false
    init(deviceId: String, sampler: StreamSampler? = nil, clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         discard: @escaping @Sendable () -> Void = {},
         present: @escaping @Sendable (NativeDevicePicture) -> Void, acknowledge: @escaping @Sendable (NativeDeviceAck) -> Void) {
        self.deviceId = deviceId; self.sampler = sampler; self.clock = clock; self.discard = discard
        self.present = present; self.acknowledge = acknowledge
    }
    func receiveVideo(_ chunk: DeviceFrameChunk, path: String = MediaDelivery.channel) {
        guard chunk.isLiveVideo else { return }
        receive(chunk, path: path)
    }
    func receiveScreen(_ chunk: DeviceFrameChunk, path: String = MediaDelivery.channel) {
        guard !chunk.still else { return }
        receive(chunk, path: path)
    }
    /// The script set this source's delivery; another source's is ignored.
    func delivery(_ source: String, _ delivery: MediaDelivery) {
        guard source == deviceId else { return }
        queue.async { [self] in
            guard !closed else { return }
            let change = gate.set(delivery)
            if change.reset { streamId = nil; sequence = -1; decoder = nil; discard() }
            for chunk in change.released { decode(chunk, generation: delivery.generation) }
            if let ask = change.keyframe {
                acknowledge(NativeDeviceAck(deviceId: deviceId, streamId: ask.streamId, sequence: ask.sequence, keyframe: true,
                                            generation: delivery.generation))
            }
        }
    }
    private func receive(_ chunk: DeviceFrameChunk, path: String) {
        guard chunk.deviceId == deviceId else { return }
        sampler?.arrived(bytes: chunk.bytes.count)
        queue.async { [self] in
            guard !closed else { return }
            if case .show(let generation) = gate.arrive(chunk, path: path, at: clock()) { decode(chunk, generation: generation) }
        }
    }
    private func decode(_ chunk: DeviceFrameChunk, generation: Int?) {
        if streamId != chunk.streamId { streamId = chunk.streamId; sequence = -1; decoder = nil }
        guard chunk.sequence > sequence else { return }
        if sequence >= 0, chunk.sequence != sequence + 1, !chunk.key { decoder = nil }
        sequence = chunk.sequence
        var needsKeyframe = false
        var fallback = false
        do {
            if chunk.isJPEG {
                present(NativeDevicePicture(image: try NativeJPEG.decode(chunk), chunk: chunk))
                decoder = nil
            } else {
                if chunk.key {
                    let sets: [Data]?
                    if VideoCapabilities.isHEVC(chunk.codec) { sets = AnnexB.hevcParameterSets(chunk.bytes) }
                    else { sets = AnnexB.parameterSets(chunk.bytes).map { $0.sequence + $0.picture } }
                    guard let sets else { throw AnnexB.ParseError.noNALUnits }
                    if decoder?.parameterSets != sets { decoder = try VideoDecoder(annexBKeyframe: chunk.bytes, codec: chunk.codec) }
                }
                if let decoder { present(NativeDevicePicture(image: try decoder.decode(annexB: chunk.bytes), chunk: chunk)) }
                else { needsKeyframe = true }
            }
        } catch { decoder = nil; needsKeyframe = true; fallback = VideoCapabilities.isHEVC(chunk.codec) }
        if needsKeyframe { sampler?.keyframeAsked() }
        acknowledge(NativeDeviceAck(deviceId: deviceId, streamId: chunk.streamId, sequence: chunk.sequence, keyframe: needsKeyframe,
                                    fallback: fallback, codec: fallback ? chunk.codec : "", generation: generation))
    }
    func close() { queue.async { [self] in closed = true; decoder = nil } }
}

@MainActor final class DeviceLiveModel {
    private var latest = LatestDevicePicture()
    private var poster = LatestPoster()
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
        let renderer = NativeRemotePictureRenderer(deviceId: deviceId, sampler: sampler, discard: { _ = latest.take() },
                                                   present: { latest.put($0) }) { ack in
            var value: [String: Any] = ["type": "devices.ack", "deviceId": ack.deviceId, "streamId": ack.streamId, "sequence": ack.sequence]
            if let generation = ack.generation { value["generation"] = generation }
            if ack.keyframe { value["keyframe"] = true }
            if ack.fallback { value["fallback"] = true; value["codec"] = ack.codec }
            ClientModel.action(value, to: session)
        }
        self.renderer = renderer; streams = session.browserStreams
        streams?.attachDevice { renderer.receiveVideo($0, path: $1) }
        streams?.attachDelivery("device") { renderer.delivery($0, $1) }
        if let known = streams?.delivery(DeliveryKey(view: "device", source: deviceId)) { renderer.delivery(deviceId, known) }
        let poster = LatestPoster(); self.poster = poster
        streams?.attachPoster(.device) { poster.put($0) }
    }
    func nextPicture() -> NativeDevicePicture? { latest.take() }
    func nextPoster() -> CGImage? { poster.take() }
    func close(deviceId: String? = nil) {
        if let deviceId, deviceId != self.deviceId { return }
        self.deviceId = nil
        streams?.attachDevice(nil); streams?.attachDelivery("device", nil); streams?.attachPoster(.device, nil); streams = nil; renderer?.close(); renderer = nil
        _ = latest.take()
    }
}
