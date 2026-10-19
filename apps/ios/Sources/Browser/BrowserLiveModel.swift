import CoreGraphics
import Foundation
import Observation

/// Draws pictures; the live view's surface implements it.
@MainActor protocol BrowserPictureSink: AnyObject {
    func show(_ picture: BrowserPicture)
}

/// The thread's live browser view on this machine: the bridge's view and page state, and the
/// pictures' path from the runtime's sockets to the screen. Acknowledgements go out once a
/// picture is shown; while the app is in the background they are owed, so the daemon's window
/// fills and it sends nothing more until the view is seen again (as the web does when hidden).
@MainActor @Observable final class BrowserLiveModel {
    /// The thread whose browser the live view shows, while it is open.
    private(set) var threadId: String?
    private(set) var view: BrowserViewInfo?
    private(set) var page: BrowserPageInfo?
    /// The latest picture's page size (CSS pixels); nil until the first picture.
    private(set) var pageSize: CGSize?
    /// Whether the open thread has a browser with a tab open (its Browser entry).
    private(set) var live: (threadId: String, epoch: Int, value: Bool)?

    @ObservationIgnored weak var surface: BrowserPictureSink?
    @ObservationIgnored private var renderer: BrowserRenderer?
    @ObservationIgnored private var generation: Int?
    @ObservationIgnored private var visible = true
    /// Acknowledgements held while the app isn't visible: the latest JPEG frame and video chunk.
    @ObservationIgnored private var owed: (frame: BrowserAck?, video: BrowserAck?) = (nil, nil)
    @ObservationIgnored private var sendAck: (BrowserAck) -> Void = { _ in }

    func hasBrowser(_ threadId: String, epoch: Int) -> Bool {
        guard let live else { return false }
        return live.threadId == threadId && live.epoch == epoch && live.value
    }

    /// Start showing `threadId`'s browser: pictures from `streams` are decoded off the main thread.
    func open(threadId: String, streams: BrowserStreamHub?, ack: @escaping (BrowserAck) -> Void) {
        close(streams: streams)
        self.threadId = threadId
        sendAck = ack
        let renderer = BrowserRenderer(threadId: threadId, present: { [weak self] picture in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.present(picture) } }
        }, ack: { [weak self] value in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.acknowledge(value) } }
        })
        self.renderer = renderer
        streams?.attach { message in renderer.receive(message) }
    }
    func close(streams: BrowserStreamHub?) {
        streams?.attach(nil)
        renderer?.close()
        renderer = nil
        threadId = nil; view = nil; page = nil; pageSize = nil; generation = nil
        owed = (nil, nil)
        sendAck = { _ in }
    }
    /// The app came to the foreground or left it.
    func setVisible(_ value: Bool) {
        visible = value
        guard value else { return }
        let held = owed
        owed = (nil, nil)
        if let frame = held.frame { sendAck(frame) }
        if let video = held.video { sendAck(video) }
    }

    func apply(_ patch: BrowserPatch) {
        switch patch {
        case .available(let threadId, let epoch, let value):
            live = (threadId, epoch, value)
        case .view(let threadId, let info):
            guard threadId == self.threadId else { return }
            if let generation, generation != info.generation {
                // The daemon starts this viewer's pictures again: wait for its next keyframe.
                renderer?.reset()
            }
            generation = info.generation
            if view != info { view = info }
        case .page(let threadId, _, let info):
            guard threadId == self.threadId else { return }
            if page != info { page = info }
        }
    }

    private func present(_ picture: BrowserPicture) {
        guard threadId != nil else { return }
        surface?.show(picture)
        if pageSize != picture.page { pageSize = picture.page }
        acknowledge(BrowserAck(sequence: picture.sequence, video: picture.video))
    }
    private func acknowledge(_ value: BrowserAck) {
        guard threadId != nil else { return }
        guard visible else {
            if value.video {
                // Cumulative: the newest sequence, still asking for a keyframe if any did.
                let earlier = owed.video
                owed.video = BrowserAck(sequence: max(value.sequence, earlier?.sequence ?? 0), video: true,
                                        keyframe: value.keyframe || earlier?.keyframe == true)
            } else { owed.frame = value }
            return
        }
        sendAck(value)
    }
}
