import CoreGraphics
import Foundation

/// One screen session at a time, using the same native pixel renderer and bounded latest frame.
@MainActor final class ScreenLiveModel {
    private var latest = LatestDevicePicture()
    private var poster = LatestPoster()
    private var renderer: NativeRemotePictureRenderer?
    private var streams: BrowserStreamHub?
    private(set) var sessionId: String?
    func open(sessionId: String, session: any ClientSession) {
        close(); self.sessionId = sessionId
        let latest = LatestDevicePicture(); self.latest = latest
        let renderer = NativeRemotePictureRenderer(deviceId: sessionId, present: { latest.put($0) }) { ack in
            var action: [String: Any] = ["type": "screen.ack", "sessionId": ack.deviceId, "streamId": ack.streamId, "sequence": ack.sequence]
            if ack.keyframe { action["keyframe"] = true }
            if ack.fallback { action["fallback"] = true; action["codec"] = ack.codec }
            ClientModel.action(action, to: session)
        }
        self.renderer = renderer; streams = session.browserStreams
        streams?.attachScreen { renderer.receiveScreen($0) }
        let poster = LatestPoster(); self.poster = poster
        streams?.attachPoster(.screen) { poster.put($0) }
    }
    func nextPicture() -> NativeDevicePicture? { latest.take() }
    func nextPoster() -> CGImage? { poster.take() }
    func close() {
        sessionId = nil; streams?.attachScreen(nil); streams?.attachPoster(.screen, nil); streams = nil
        renderer?.close(); renderer = nil; _ = latest.take()
    }
}
