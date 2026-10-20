import CoreGraphics
import Foundation
import Observation

/// The thread's live browser view on this machine: the bridge's view and page state, and the
/// pictures' path from the runtime's sockets to the screen. Chunks are decoded and acknowledged
/// off the main thread (`BrowserRenderer`, `BrowserAcks`); the surface's display link takes the
/// newest picture once per refresh (`nextPicture`), so nothing observed here changes per frame.
@MainActor @Observable final class BrowserLiveModel {
    /// The thread whose browser the live view shows, while it is open.
    private(set) var threadId: String?
    private(set) var view: BrowserViewInfo?
    private(set) var page: BrowserPageInfo?
    /// The drawn picture's page size (CSS pixels); nil until the first picture is drawn.
    private(set) var pageSize: CGSize?
    /// Whether the open thread has a browser with a tab open (its Browser entry).
    private(set) var live: (threadId: String, epoch: Int, value: Bool)?

    @ObservationIgnored private var renderer: BrowserRenderer?
    @ObservationIgnored private var latest: LatestBrowserPicture?
    @ObservationIgnored private var acks: BrowserAcks?
    @ObservationIgnored private var generation: Int?
    @ObservationIgnored private var visible = true

    func hasBrowser(_ threadId: String, epoch: Int) -> Bool {
        guard let live else { return false }
        return live.threadId == threadId && live.epoch == epoch && live.value
    }

    /// Start showing `threadId`'s browser: chunks from `streams` are decoded off the main thread,
    /// and `ack` is called from the decoding queue.
    func open(threadId: String, streams: BrowserStreamHub?, ack: @escaping @Sendable (BrowserAck) -> Void) {
        close(streams: streams)
        self.threadId = threadId
        let latest = LatestBrowserPicture()
        let acks = BrowserAcks(visible: visible, send: ack)
        let renderer = BrowserRenderer(threadId: threadId, present: { latest.put($0) }, ack: { acks.acknowledge($0) })
        self.latest = latest
        self.acks = acks
        self.renderer = renderer
        streams?.attach { chunk in renderer.receive(chunk) }
    }
    func close(streams: BrowserStreamHub?) {
        streams?.attach(nil)
        renderer?.close()
        acks?.close()
        renderer = nil; latest = nil; acks = nil
        threadId = nil; view = nil; page = nil; pageSize = nil; generation = nil
    }
    /// The app came to the foreground or left it.
    func setVisible(_ value: Bool) {
        visible = value
        acks?.setVisible(value)
    }
    /// The newest picture decoded since the last call, for the display link; older ones are dropped.
    func nextPicture() -> BrowserPicture? {
        guard let picture = latest?.take() else { return nil }
        if pageSize != picture.page { pageSize = picture.page }
        return picture
    }

    func apply(_ patch: BrowserPatch) {
        switch patch {
        case .available(let threadId, let epoch, let value):
            live = (threadId, epoch, value)
        case .view(let threadId, let info):
            guard threadId == self.threadId else { return }
            if let generation, generation != info.generation {
                // The daemon starts this viewer's video again: the last picture stays until its next keyframe.
                renderer?.reset()
            }
            generation = info.generation
            if view != info { view = info }
        case .page(let threadId, _, let info):
            guard threadId == self.threadId else { return }
            if page != info { page = info }
        }
    }
}
