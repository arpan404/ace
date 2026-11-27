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
    @ObservationIgnored private(set) var subscription: UUID?
    private(set) var view: BrowserViewInfo?
    private(set) var page: BrowserPageInfo?
    /// The drawn picture's page size (CSS pixels); nil until the first picture is drawn.
    private(set) var pageSize: CGSize?
    /// A subscribe's poster is on screen in place of the page until its first live picture.
    private(set) var posterShown = false
    /// Why the page's pictures don't come, or haven't yet: one sentence, nil once one does.
    private(set) var waiting: String?
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
    /// The person's input round trip to the page in milliseconds, once they have used it.
    private(set) var latency: Int?
    /// Each tab's last picture once another tab shows, for an iPad's split (newest eight).
    private(set) var stills: [String: UIImage] = [:]
    /// The person turned the page's sound on for this view (ADR 0088 › Audio); every view starts muted.
    private(set) var soundHere = false
    /// The page floats in picture-in-picture now (`BrowserPipRule`).
    private(set) var pipActive = false
    /// The stream stays open for picture-in-picture after the person left the Browser.
    private(set) var keptForPip = false
    /// Bumped when the person asks picture-in-picture to go back to the page: that thread's Browser opens.
    private(set) var pipRestore: (threadId: String, count: Int)?
    @ObservationIgnored let pip = BrowserPictureInPicture()
    /// Settings › Browser › Picture in picture, on this phone.
    @ObservationIgnored var pipEnabled: () -> Bool = { UserDefaults.standard.object(forKey: BrowserPipRule.settingKey) as? Bool ?? true }
    @ObservationIgnored private var showingBrowser = false
    @ObservationIgnored private var pipDismissed = false
    /// Leaving the app floats the page by itself.
    @ObservationIgnored private(set) var pipArmed = false
    /// The picture on screen now and the tab it came from.
    @ObservationIgnored var currentPicture: () -> (image: CVPixelBuffer, tabId: String)? = { nil }
    @ObservationIgnored private var stillOrder: [String] = []

    @ObservationIgnored private var renderer: BrowserRenderer?
    @ObservationIgnored private var latest: LatestBrowserPicture?
    @ObservationIgnored private var poster: LatestPoster?
    @ObservationIgnored private var acks: BrowserAcks?
    @ObservationIgnored private var generation: Int?
    @ObservationIgnored private var visible = true
    @ObservationIgnored private let sound = BrowserSoundPlayer()

    func hasBrowser(_ threadId: String, epoch: Int) -> Bool {
        guard let live else { return false }
        return live.threadId == threadId && live.epoch == epoch && live.value
    }

    /// Start showing `threadId`'s browser: chunks from `streams` are decoded off the main thread,
    /// and `ack` is called from the decoding queue.
    func open(threadId: String, streams: BrowserStreamHub?, ack: @escaping @Sendable (BrowserAck) -> Void) {
        close(streams: streams)
        self.threadId = threadId
        subscription = UUID()
        let latest = LatestBrowserPicture()
        let acks = BrowserAcks(visible: visible, send: ack)
        let poster = LatestPoster()
        self.poster = poster
        let renderer = BrowserRenderer(threadId: threadId, discard: { _ = latest.take() }, showPoster: { poster.put($0) },
                                       waiting: { [weak self] text in
                                           Task { @MainActor in if self?.threadId == threadId { self?.waiting = text } }
                                       },
                                       sound: sound, present: { latest.put($0) }, ack: { acks.acknowledge($0) })
        self.latest = latest
        self.acks = acks
        self.renderer = renderer
        streams?.attach { chunk, path in renderer.receive(chunk, path: path) }
        streams?.attachAudio { chunk, path in renderer.receive(chunk, path: path) }
        renderer.follow(streams)
        pip.nextPicture = { [weak self] in self?.nextPicture() }
        pip.onActive = { [weak self] active in self?.pipChanged(active) }
    }
    func close(streams: BrowserStreamHub?) {
        streams?.attach(nil)
        streams?.attachAudio(nil)
        streams?.attachDelivery("browser", nil)
        poster = nil
        renderer?.close()
        acks?.close()
        renderer = nil; latest = nil; acks = nil
        subscription = nil
        threadId = nil; view = nil; page = nil; pageSize = nil; generation = nil; posterShown = false; waiting = nil
        pictureZoom = 1; pictureOffset = .zero
        find = nil; shot = nil; logs = nil; visits = []; visitCount = 0; problem = nil; upload = nil
        done = nil; source = nil; sizes = nil; extensions = nil; latency = nil
        stills = [:]; stillOrder = []
        soundHere = false
        updateSound()
        keptForPip = false
        pip.stop()
        updatePip()
    }
    /// The Browser is on screen, or the person left it.
    func setShowingBrowser(_ value: Bool) {
        showingBrowser = value
        if value { pipDismissed = false; keptForPip = false }
        updatePip()
    }
    /// The person left the Browser: true when the page floats, and its stream stays open for it.
    func floatOnLeaving() -> Bool {
        guard threadId != nil, BrowserPipRule.shows(state: view?.state, showingBrowser: false, dismissed: pipDismissed, enabled: pipEnabled()),
              pip.start() else { return false }
        keptForPip = true
        return true
    }
    /// What ending picture-in-picture leaves to do: close the stream kept for it, or mute the page
    /// the person dismissed while away from it.
    enum PipEnd: Equatable { case close, mute, none }
    /// Picture-in-picture ended; `restore` when the person asked to go back to the page.
    func pipEnded(restore: Bool) -> PipEnd {
        let onScreen = showingBrowser && visible
        if !restore, !onScreen {
            pipDismissed = true
            updatePip()
        }
        if keptForPip {
            if restore, let threadId { pipRestore = (threadId, (pipRestore?.count ?? 0) + 1) }
            return .close
        }
        return restore || onScreen ? .none : .mute
    }
    /// Re-reads the rule: arms the float for leaving the app, and ends one the rule no longer holds.
    func updatePip() {
        let state = view?.state
        let enabled = pipEnabled()
        let away = threadId != nil && BrowserPipRule.shows(state: state, showingBrowser: false, dismissed: pipDismissed, enabled: enabled)
        pipArmed = showingBrowser && away
        pip.arm(pipArmed)
        let onScreen = showingBrowser && visible
        if pip.active, !(threadId != nil && BrowserPipRule.shows(state: state, showingBrowser: onScreen, dismissed: pipDismissed, enabled: enabled)) {
            pip.stop()
        }
    }
    /// While the page floats, its pictures are acknowledged as if shown, so they keep coming.
    private func pipChanged(_ active: Bool) {
        if pipActive != active { pipActive = active }
        acks?.setVisible(visible || active)
    }
    /// The person's speaker: this phone plays the page's sound, or stops. The bridge is told separately.
    func setSoundHere(_ on: Bool) {
        guard threadId != nil || !on else { return }
        if soundHere != on { soundHere = on }
        updateSound()
    }
    /// The audio output is open only while the shown tab plays to this phone (`BrowserSound.plays`).
    private func updateSound() {
        sound.set(BrowserSound.plays(here: soundHere, open: threadId != nil, shown: view?.state?.shown))
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
        acks?.setVisible(value || pipActive)
        updatePip()
    }
    /// The poster a subscribe brought back since the last call, for the display link.
    func nextPoster() -> CGImage? {
        guard let image = poster?.take() else { return nil }
        if pageSize == nil, !posterShown { posterShown = true }
        return image
    }
    /// The newest picture decoded since the last call, for the display link; older ones are dropped.
    func nextPicture() -> BrowserPicture? {
        guard let picture = latest?.take() else { return nil }
        if pageSize != picture.page { pageSize = picture.page }
        sound.shown(timestamp: picture.timestamp)
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
            updateSound()
            updatePip()
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
        case .latency(let threadId, let ms): if threadId == self.threadId, latency != ms { latency = ms }
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
