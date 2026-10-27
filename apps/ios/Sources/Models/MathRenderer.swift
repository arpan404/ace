import SwiftUI
import UIKit
import WebKit

/// One formula of a finished answer, as the bridge found it (`mathSpans` in `@ace/ui-core`).
struct MathSpan: Codable, Sendable, Equatable {
    let tex: String
    let display: Bool
    /// Its text form, drawn until the typeset formula is, and if it can't be.
    let text: String
}

/// A typeset formula: a template image (drawn in whatever ink its text has, so one image serves
/// light and dark) and where its baseline falls, in points from its top.
struct MathImage {
    let image: UIImage
    let baseline: CGFloat
}

/// Typesets formulas with KaTeX, the web's renderer and safety settings, in one offscreen web
/// view that loads the bundled page (`Resources/math.html`, built by `scripts/build-math.ts`)
/// the first time an answer holds math. Formulas are typeset one at a time, off any gesture or
/// scroll, each within two seconds, and each result is kept, so a formula is typeset once per
/// size in a launch. A formula KaTeX refuses (or that takes too long) answers nil and is
/// remembered; a page that can't load or whose process died answers nil and is built again for
/// the next formula. Either way the text form stays.
@MainActor final class MathRenderer: NSObject, WKNavigationDelegate {
    static let shared = MathRenderer()
    /// How long one formula may take, typeset and snapshotted, before it is given up on.
    static let limit: Duration = .seconds(2)
    /// Formulas waiting at most: past it a formula keeps its text form until it is asked again.
    static let backlog = 24
    /// How long the page may take to load before it is given up on (and tried again later).
    static let loadLimit: Duration = .seconds(5)
    private var web: WKWebView?
    private var page: URL?
    /// Everyone waiting for the page to load: the first formulas may all ask.
    private var loading: [CheckedContinuation<Void, Never>] = []
    private var ready = false
    private var queue: Task<Void, Never>?
    private var waiting = 0
    private let images = NSCache<NSString, Box>()
    /// Formulas KaTeX refused or that took too long, bounded.
    private let refused = NSCache<NSString, NSNumber>()
    private var rules: WKContentRuleList?
    private final class Box { let value: MathImage; init(_ value: MathImage) { self.value = value } }
    /// What one attempt came to: only KaTeX's own refusal and a timeout are remembered.
    private enum Outcome { case typeset(MathImage), refused, unavailable }

    override private init() {
        images.totalCostLimit = 16 * 1024 * 1024
        refused.countLimit = 512
        super.init()
    }

    private static func key(_ span: MathSpan, size: CGFloat) -> String { "\(span.display ? "D" : "I")\(Int(size * 10))\u{0}\(span.tex)" }

    /// A formula already typeset at `size`, for drawing on the first frame.
    func cached(_ span: MathSpan, size: CGFloat) -> MathImage? {
        images.object(forKey: Self.key(span, size: size) as NSString)?.value
    }

    /// The formula typeset at `size` points; nil when it can't be. Cancelling the caller's task
    /// cancels its formula if it hasn't started.
    func render(_ span: MathSpan, size: CGFloat) async -> MathImage? {
        let key = Self.key(span, size: size) as NSString
        if let hit = images.object(forKey: key) { return hit.value }
        if refused.object(forKey: key) != nil || waiting >= Self.backlog || Task.isCancelled { return nil }
        waiting += 1
        let previous = queue
        let work = Task { () -> Outcome in
            await previous?.value
            defer { waiting -= 1 }
            if let hit = images.object(forKey: key) { return .typeset(hit.value) }
            if Task.isCancelled { return .unavailable }
            return await typesetWithin(span, size: size)
        }
        queue = Task { _ = await work.value }
        let outcome = await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
        switch outcome {
        case .typeset(let image):
            let pixels = image.image.size.width * image.image.size.height * image.image.scale * image.image.scale
            images.setObject(Box(image), forKey: key, cost: Int(pixels))
            return image
        case .refused:
            refused.setObject(1, forKey: key)
            return nil
        case .unavailable:
            return nil
        }
    }

    /// One formula against the clock. A page still busy past the limit is thrown away, so the
    /// next formula never meets a half-typeset one.
    private func typesetWithin(_ span: MathSpan, size: CGFloat) async -> Outcome {
        guard let web = await loadedPage(), !Task.isCancelled else { return .unavailable }
        return await withCheckedContinuation { (finished: CheckedContinuation<Outcome, Never>) in
            var answered = false
            let answer: (Outcome) -> Void = { outcome in
                guard !answered else { return }
                answered = true
                finished.resume(returning: outcome)
            }
            Task { answer(await self.typeset(span, size: size, on: web)) }
            Task {
                try? await Task.sleep(for: Self.limit)
                guard !answered else { return }
                self.discard(web)
                answer(.refused)
            }
        }
    }

    private func typeset(_ span: MathSpan, size: CGFloat, on web: WKWebView) async -> Outcome {
        let reply: Any?
        do {
            reply = try await web.callAsyncJavaScript("return await aceMath(tex, display, size)",
                                                      arguments: ["tex": span.tex, "display": span.display, "size": Double(size)],
                                                      contentWorld: .page)
        } catch {
            return .unavailable
        }
        // KaTeX itself said no: the only answer that means this formula can't be typeset.
        guard let box = reply as? [String: Any] else { return reply == nil || reply is NSNull ? .refused : .unavailable }
        guard let x = (box["x"] as? NSNumber)?.doubleValue, let y = (box["y"] as? NSNumber)?.doubleValue,
              let width = (box["width"] as? NSNumber)?.doubleValue, let height = (box["height"] as? NSNumber)?.doubleValue,
              let baseline = (box["baseline"] as? NSNumber)?.doubleValue,
              width > 0, height > 0, x + width <= Double(web.bounds.width), y + height <= Double(web.bounds.height)
        else { return .refused }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(x: x, y: y, width: width, height: height)
        configuration.snapshotWidth = NSNumber(value: width)
        configuration.afterScreenUpdates = true
        guard let shot = try? await web.takeSnapshot(configuration: configuration) else { return .unavailable }
        guard let drawn = await Task.detached(priority: .utility, operation: { Self.inked(shot) }).value else { return .refused }
        return .typeset(MathImage(image: drawn.image.withRenderingMode(.alwaysTemplate), baseline: baseline - drawn.top))
    }

    /// The snapshot cropped to the pixels KaTeX drew, and how far down the crop starts, in points.
    nonisolated private static func inked(_ shot: UIImage) -> (image: UIImage, top: CGFloat)? {
        guard let cg = shot.cgImage else { return nil }
        let width = cg.width, height = cg.height
        var alpha = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(data: &alpha, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue) else { return nil }
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            let row = y * width
            for x in 0..<width where alpha[row + x] > 8 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        // A pixel of air on each side, so antialiased edges are never cut.
        let crop = CGRect(x: max(0, minX - 2), y: max(0, minY - 2),
                          width: min(width, maxX + 3) - max(0, minX - 2), height: min(height, maxY + 3) - max(0, minY - 2))
        guard let cropped = cg.cropping(to: crop) else { return nil }
        return (UIImage(cgImage: cropped, scale: shot.scale, orientation: .up), crop.minY / shot.scale)
    }

    /// Requests the page may make: none. Only the bundled page itself (a file) and the fonts
    /// inlined in it (data) load, so even a page whose CSP regressed can't reach the network.
    private static let blockedRequests = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^file:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}}]
    """

    /// The page, loaded once. It sits in the window but off screen: a web view draws (and so
    /// can be snapshotted) only while it is in one. It never takes touches or VoiceOver focus.
    private func loadedPage() async -> WKWebView? {
        if let web, ready { return web }
        if web == nil {
            guard let url = Bundle.main.url(forResource: "math", withExtension: "html"), let window = host() else { return nil }
            if rules == nil {
                rules = try? await WKContentRuleListStore.default().compileContentRuleList(
                    forIdentifier: "ace.math.offline", encodedContentRuleList: Self.blockedRequests)
            }
            // No rules, no page: it never loads without them.
            guard let rules, web == nil else { return web == nil ? nil : await waitForPage() }
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.userContentController.add(rules)
            let view = WKWebView(frame: CGRect(x: -5000, y: 0, width: 2000, height: 800), configuration: configuration)
            view.isOpaque = false
            view.backgroundColor = .clear
            view.scrollView.backgroundColor = .clear
            view.scrollView.isScrollEnabled = false
            // The window's safe area would push the page down under the snapshot's rectangle.
            view.scrollView.contentInsetAdjustmentBehavior = .never
            view.isUserInteractionEnabled = false
            view.accessibilityElementsHidden = true
            view.navigationDelegate = self
            window.insertSubview(view, at: 0)
            web = view
            page = url
            view.loadFileURL(url, allowingReadAccessTo: url)
            // A page that never finishes loading is given up on, never waited for forever.
            Task {
                try? await Task.sleep(for: Self.loadLimit)
                if self.web === view, !self.ready { self.finishLoading(ok: false) }
            }
        }
        return await waitForPage()
    }
    /// A window for the page: the app's own, or, with none on screen yet, a window of the page's
    /// own on the app's scene that takes no touches and never becomes key.
    private var ownWindow: UIWindow?
    private func host() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows).filter { $0 !== ownWindow }
        if let window = windows.first(where: \.isKeyWindow) ?? windows.first { return window }
        if let ownWindow { return ownWindow }
        guard let scene = scenes.first else { return nil }
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue - 1)
        window.isUserInteractionEnabled = false
        window.accessibilityElementsHidden = true
        window.isHidden = false
        ownWindow = window
        return window
    }
    private func waitForPage() async -> WKWebView? {
        if !ready { await withCheckedContinuation { loading.append($0) } }
        return ready ? web : nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === web { finishLoading(ok: true) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        if webView === web { finishLoading(ok: false) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        if webView === web { finishLoading(ok: false) }
    }
    /// WebKit's process for the page died (memory pressure, a crash): the next formula builds it again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        discard(webView)
    }
    /// Only the bundled page itself ever loads: its exact URL, nothing else on disk or anywhere.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.absoluteString == "about:blank" { return .allow }
        // The same file, however WebKit spells its path (`/var` or `/private/var`).
        guard url.isFileURL, let page else { return .cancel }
        return url.resolvingSymlinksInPath().path == page.resolvingSymlinksInPath().path ? .allow : .cancel
    }
    private func finishLoading(ok: Bool) {
        ready = ok
        if !ok { discard(web) }
        let waiters = loading
        loading = []
        for waiter in waiters { waiter.resume() }
    }
    /// Throws the page away; the next formula loads a fresh one.
    private func discard(_ view: WKWebView?) {
        guard let view, view === web else { return }
        view.navigationDelegate = nil
        view.removeFromSuperview()
        web = nil
        ready = false
        let waiters = loading
        loading = []
        for waiter in waiters { waiter.resume() }
    }
}

extension EnvironmentValues {
    /// The finished answer's formulas, by the index their markers carry.
    @Entry var markdownMath: [MathSpan] = []
}

enum MathMarkers {
    /// Prose and formula markers in order: `.prose(text)` and `.formula(index)`.
    enum Piece: Equatable { case prose(String), formula(Int) }
    static func pieces(_ text: String) -> [Piece] {
        var pieces: [Piece] = []
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "\u{E000}"), let close = rest[open...].firstIndex(of: "\u{E001}") {
            if open > rest.startIndex { pieces.append(.prose(String(rest[..<open]))) }
            if let index = Int(rest[rest.index(after: open)..<close]) { pieces.append(.formula(index)) }
            rest = rest[rest.index(after: close)...]
        }
        if !rest.isEmpty { pieces.append(.prose(String(rest))) }
        return pieces
    }
    /// The text with each formula in its text form, where a formula can't be drawn inline.
    static func plain(_ text: String, _ math: [MathSpan]) -> String {
        guard text.contains("\u{E000}") else { return text }
        return pieces(text).map { piece in
            switch piece {
            case .prose(let prose): prose
            case .formula(let index): index < math.count ? math[index].text : ""
            }
        }.joined()
    }
    /// The font size formulas typeset at: the prose's, at the reader's text size.
    @MainActor static func size(_ dynamicType: DynamicTypeSize) -> CGFloat {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicType))
        return UIFontMetrics(forTextStyle: .body).scaledValue(for: AceTheme.Typography.body.size, compatibleWith: traits)
    }
}
