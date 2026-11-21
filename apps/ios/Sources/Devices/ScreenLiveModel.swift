import CoreGraphics
import Foundation
import Observation

/// One screen session at a time, using the same native pixel renderer and bounded latest frame.
@MainActor @Observable final class ScreenLiveModel {
    @ObservationIgnored private var latest = LatestDevicePicture()
    @ObservationIgnored private var poster = LatestPoster()
    @ObservationIgnored private var renderer: NativeRemotePictureRenderer?
    @ObservationIgnored private var streams: BrowserStreamHub?
    private(set) var sessionId: String?
    /// Why the window's pictures don't come, or haven't yet: one sentence, nil once one does.
    private(set) var waiting: String?
    func open(sessionId: String, session: any ClientSession) {
        close(); self.sessionId = sessionId
        let latest = LatestDevicePicture(); self.latest = latest
        let poster = LatestPoster(); self.poster = poster
        let renderer = NativeRemotePictureRenderer(deviceId: sessionId, discard: { _ = latest.take() }, showPoster: { poster.put($0) },
                                                   waiting: { [weak self] text in
                                                       Task { @MainActor in if self?.sessionId == sessionId { self?.waiting = text } }
                                                   },
                                                   present: { latest.put($0) }) { ack in
            var action: [String: Any] = ["type": "screen.ack", "sessionId": ack.deviceId, "streamId": ack.streamId, "sequence": ack.sequence]
            if let generation = ack.generation { action["generation"] = generation }
            if ack.keyframe { action["keyframe"] = true }
            if ack.fallback { action["fallback"] = true; action["codec"] = ack.codec }
            ClientModel.action(action, to: session)
        }
        self.renderer = renderer; streams = session.browserStreams
        streams?.attachScreen { renderer.receiveScreen($0, path: $1) }
        renderer.follow(streams, view: "screen")
    }
    func nextPicture() -> NativeDevicePicture? { latest.take() }
    func nextPoster() -> CGImage? { poster.take() }
    func close() {
        sessionId = nil; waiting = nil; streams?.attachScreen(nil); streams?.attachDelivery("screen", nil); streams = nil
        renderer?.close(); renderer = nil; _ = latest.take()
    }
}
