import CryptoKit
import SwiftUI
import UIKit
import WebKit

/// A published page as the transcript draws it: the outer document and its content hash, which
/// keys what the thread keeps of it (its height, its loaded web view).
struct CanvasPage: Equatable {
    let document: String
    let id: String
    init(document: String) {
        self.document = document
        id = SHA256.hash(data: Data(document.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// What one thread keeps of the pages it has drawn, so a page scrolled back into view comes back
/// at once at the height it had: each page's last measured height, and the last few loaded views
/// off screen, ready to put back without loading again. A view on screen is never on the shelf.
/// Generic over the view so its keeping and eviction can be tested without WebKit.
@MainActor final class CanvasShelf<Kept: AnyObject> {
    private var heights: [String: CGFloat] = [:]
    private var heightOrder: [String] = []
    private var kept: [(id: String, view: Kept)] = []
    let maxHeights: Int
    let maxKept: Int

    init(maxHeights: Int = 256, maxKept: Int = 6) {
        self.maxHeights = maxHeights
        self.maxKept = maxKept
    }

    /// The height page `id` last measured, if it has been drawn.
    func height(_ id: String) -> CGFloat? { heights[id] }

    func remember(height: CGFloat, for id: String) {
        if heights.updateValue(height, forKey: id) == nil { heightOrder.append(id) }
        while heightOrder.count > maxHeights { heights[heightOrder.removeFirst()] = nil }
    }

    /// Takes page `id`'s loaded view off the shelf, for a row coming on screen.
    func take(_ id: String) -> Kept? {
        guard let index = kept.firstIndex(where: { $0.id == id }) else { return nil }
        return kept.remove(at: index).view
    }

    /// Puts a view that went off screen on the shelf; past the limit the longest kept goes.
    func put(_ view: Kept, for id: String) {
        kept.removeAll { $0.id == id }
        kept.append((id, view))
        if kept.count > maxKept { kept.removeFirst(kept.count - maxKept) }
    }

    var keptCount: Int { kept.count }
}

/// A page inline in the transcript: as tall as its content, which the trusted outer document
/// reports through its title (the authored page, in its own opaque-origin frame, cannot set it).
/// It opens at the height it last measured and reuses its loaded view when the thread kept one.
/// The transcript scrolls, not the page; it keeps its own taps and gestures.
struct InlineCanvas: View {
    let page: CanvasPage
    let title: String
    let shelf: CanvasShelf<WKWebView>?
    @State private var reported: CGFloat?

    static let placeholderHeight: CGFloat = 160

    var body: some View {
        let height = reported ?? shelf?.height(page.id) ?? Self.placeholderHeight
        MeasuredCanvas(page: page, shelf: shelf) { measured in
            shelf?.remember(height: measured, for: page.id)
            if abs((reported ?? height) - measured) >= 1 { reported = measured }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .accessibilityLabel(title)
    }
}

private struct MeasuredCanvas: UIViewRepresentable {
    let page: CanvasPage
    let shelf: CanvasShelf<WKWebView>?
    let onHeight: (CGFloat) -> Void

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        container.clipsToBounds = true
        return container
    }
    func updateUIView(_ container: UIView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onHeight = onHeight
        guard coordinator.pageId != page.id else { return }
        coordinator.release(to: shelf)
        let view: WKWebView
        if let kept = shelf?.take(page.id) {
            view = kept
        } else {
            view = Self.makeWebView()
            PerfProbe.add("canvas.loads", 1)
            view.loadHTMLString(page.document, baseURL: nil)
        }
        view.navigationDelegate = coordinator
        view.frame = container.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(view)
        coordinator.show(view, page: page.id)
    }
    static func dismantleUIView(_ container: UIView, coordinator: Coordinator) {
        coordinator.release(to: coordinator.shelf)
    }
    func makeCoordinator() -> Coordinator { Coordinator(shelf: shelf, onHeight: onHeight) }

    private static func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.accessibilityIdentifier = "canvas.inline"
        return view
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        let shelf: CanvasShelf<WKWebView>?
        var onHeight: (CGFloat) -> Void
        private(set) var pageId: String?
        private weak var view: WKWebView?
        private var observation: NSKeyValueObservation?
        init(shelf: CanvasShelf<WKWebView>?, onHeight: @escaping (CGFloat) -> Void) {
            self.shelf = shelf
            self.onHeight = onHeight
        }
        /// Watches the page's reported height, starting with the one a kept view already has.
        func show(_ view: WKWebView, page: String) {
            self.view = view
            pageId = page
            // Reported after the update that showed the view, never during it.
            observation = view.observe(\.title, options: [.initial, .new]) { [weak self] view, _ in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self, self.view === view, let reported = pageHeight(view.title ?? "") else { return }
                        self.onHeight(reported)
                    }
                }
            }
        }
        /// The row went off screen (or shows another page): its view goes back on the shelf.
        func release(to shelf: CanvasShelf<WKWebView>?) {
            observation?.invalidate(); observation = nil
            guard let view, let pageId else { return }
            view.removeFromSuperview()
            view.navigationDelegate = nil
            shelf?.put(view, for: pageId)
            self.view = nil
            self.pageId = nil
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let scheme = navigationAction.request.url?.scheme
            decisionHandler(scheme == "about" || scheme == "data" ? .allow : .cancel)
        }
    }
}

/// The height the outer document puts in its title, `ace.html.height:<1–10000>`.
nonisolated func pageHeight(_ title: String) -> CGFloat? {
    guard title.hasPrefix("ace.html.height:"), let value = Int(title.dropFirst("ace.html.height:".count)),
          (1...10_000).contains(value) else { return nil }
    return CGFloat(value)
}
