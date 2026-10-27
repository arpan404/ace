import CoreGraphics
import CoreImage
import Foundation
import Observation
import UIKit

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
    /// The devices the device toolbar offers (`bridge/browser-device.ts`).
    private(set) var presets: [BrowserViewInfo.Device.Preset] = []
    /// The person's zoom and move of the picture (`PageGeometry`), for what is drawn over it.
    private(set) var pictureZoom: CGFloat = 1
    private(set) var pictureOffset: CGPoint = .zero
    /// Whether the open thread has a browser with a tab open (its Browser entry).
    private(set) var live: (threadId: String, epoch: Int, value: Bool)?
    /// The tools' answers while the view is open: find's count, the newest screenshot, the
    /// console's lines, the thread's history, the last failed command and an upload's progress.
    private(set) var find: BrowserFindResult?
    var shot: BrowserShot?
    private(set) var logs: BrowserLog?
    private(set) var visits: [BrowserVisit] = []
    private(set) var visitCount = 0
    var problem: BrowserProblem?
    private(set) var upload: (chooserId: String, progress: Double)?
    /// The page commands' answers (`bridge/browser-page-tools.ts`): a finished command's sentence,
    /// the page source, screenshots at sizes, the engine's extensions and downloads being saved.
    var done: BrowserDone?
    private(set) var source: BrowserSource?
    var sizes: BrowserSizes?
    private(set) var extensions: BrowserExtensions?
    private(set) var saving: [String: BrowserSaving] = [:]
    /// Bumped by the page's own Send in annotate mode: the screen goes to the message.
    private(set) var annotateSends = 0
    /// The live page floats in Picture in Picture; the system offers it here.
    var pictureInPicture = false
    var canPictureInPicture = false
    /// Each tab's last picture once another tab shows, for an iPad's split (newest eight).
    private(set) var stills: [String: UIImage] = [:]
    /// The picture on screen now and the tab it came from.
    @ObservationIgnored var currentPicture: () -> (image: CVPixelBuffer, tabId: String)? = { nil }
    @ObservationIgnored private var stillOrder: [String] = []

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
        pictureZoom = 1; pictureOffset = .zero
        find = nil; shot = nil; logs = nil; visits = []; visitCount = 0; problem = nil; upload = nil
        done = nil; source = nil; sizes = nil; extensions = nil
        stills = [:]; stillOrder = []; pictureInPicture = false
    }
    func clearSource() { source = nil }
    /// The picture on screen now, kept as the still of the tab it came from (never assumed to be
    /// the tab shown before), made into an image off the main thread; dropped if the view moved
    /// to another thread meanwhile.
    private func keepStill() {
        guard let picture = currentPicture(), let threadId else { return }
        let held = HeldPicture(buffer: picture.image)
        let tabId = picture.tabId
        Task { [weak self] in
            let image = await Task.detached(priority: .utility) { held.image() }.value
            guard let self, let image, self.threadId == threadId else { return }
            self.stills[tabId] = image
            self.stillOrder.removeAll { $0 == tabId }
            self.stillOrder.append(tabId)
            while self.stillOrder.count > 8 { self.stills[self.stillOrder.removeFirst()] = nil }
        }
    }
    func clearExtensions() { extensions = nil }
    func forgetSaving(_ key: String) { saving[key] = nil }
    /// The machine's runtime was replaced: its saves no longer report here.
    func forgetSaves() { saving = [:] }
    func movePicture(zoom: CGFloat, offset: CGPoint) {
        if pictureZoom != zoom { pictureZoom = zoom }
        if pictureOffset != offset { pictureOffset = offset }
    }
    /// Where the picture is in a view of `size`, as the surface draws it.
    func geometry(view size: CGSize) -> PageGeometry? {
        pageSize.map { PageGeometry(view: size, page: $0, zoom: pictureZoom, offset: pictureOffset) }
    }
    func clearFind() { find = nil }
    func clearLogs() { logs = nil }
    func clearUpload() { upload = nil }
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
            if let before = view?.state?.activeTabId, before != info.state?.activeTabId { keepStill() }
            if view != info { view = info }
        case .page(let threadId, _, let info):
            guard threadId == self.threadId else { return }
            if page != info { page = info }
        case .visits(let threadId, let list, let total):
            guard threadId == self.threadId else { return }
            visits = list
            visitCount = total
        // The rest answer the open view's own commands; none apply once it has closed.
        case .find(let result): if threadId != nil { find = result }
        case .shot(let result): if threadId != nil { shot = result }
        case .logs(let result): if threadId != nil { logs = result }
        case .problem(let result): if threadId != nil { problem = result }
        case .upload(let chooserId, let progress): if threadId != nil { upload = (chooserId, progress) }
        case .presets(let list): if presets != list { presets = list }
        case .done(let result): if threadId != nil { done = result }
        case .source(let result): if threadId != nil { source = result }
        case .sizes(let result): if threadId != nil { sizes = result }
        case .extensions(let result): if threadId != nil { extensions = result }
        // A save outlives the view: the file is the person's once it is on the phone.
        case .saving(let result): saving[result.key] = result
        case .annotateSend: if threadId != nil { annotateSends += 1 }
        }
    }
}

/// A decoded picture handed to a background task to become an image; the buffer isn't written again.
private struct HeldPicture: @unchecked Sendable {
    let buffer: CVPixelBuffer
    func image() -> UIImage? {
        let picture = CIImage(cvPixelBuffer: buffer)
        // Half size is plenty for a still beside the live page.
        let scaled = picture.transformed(by: CGAffineTransform(scaleX: 0.5, y: 0.5))
        guard let cgImage = CIContext(options: [.cacheIntermediates: false]).createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
