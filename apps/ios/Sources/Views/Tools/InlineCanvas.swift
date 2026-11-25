import SwiftUI
import UIKit
import WebKit

/// A published page as the transcript draws it: the outer document and its content hash, which
/// keys what the thread keeps of it (its height, its loaded web view), and the page as the agent
/// wrote it, for Copy source.
struct CanvasPage: Equatable {
    let document: String
    let source: String
    let id: String
    init(document: String, source: String = "") {
        self.document = document
        self.source = source
        id = contentKey(document)
    }
}

/// A page inline in the transcript: as tall as its content, which the trusted outer document
/// reports through its title (the authored page, in its own opaque-origin frame, cannot set it).
/// It opens at the height it last measured and reuses its loaded view when the thread kept one.
/// The transcript scrolls, not the page; it keeps its own taps and gestures.
struct InlineCanvas: View {
    let page: CanvasPage
    /// The item the page belongs to: its height is kept under it, so even a row whose page must
    /// be read again keeps its place. Loaded views are kept under the page's content hash.
    let itemId: String
    let title: String
    let shelf: ViewShelf<WKWebView>?
    @State private var reported: CGFloat?

    static let placeholderHeight: CGFloat = 160

    var body: some View {
        let height = reported ?? shelf?.height(itemId) ?? Self.placeholderHeight
        MeasuredCanvas(page: page, shelf: shelf) { measured in
            shelf?.remember(height: measured, for: itemId)
            if abs((reported ?? height) - measured) >= 1 { reported = measured }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .accessibilityLabel(title)
    }
}

private struct MeasuredCanvas: UIViewRepresentable {
    let page: CanvasPage
    let shelf: ViewShelf<WKWebView>?
    let onHeight: (CGFloat) -> Void

    func makeUIView(context: Context) -> CanvasContainer {
        let container = CanvasContainer()
        container.backgroundColor = .clear
        container.clipsToBounds = true
        container.widthKnown = { [weak coordinator = context.coordinator, weak container] in
            guard let coordinator, let container else { return }
            coordinator.attach(in: container)
        }
        return container
    }
    func updateUIView(_ container: CanvasContainer, context: Context) {
        let coordinator = context.coordinator
        coordinator.onHeight = onHeight
        coordinator.shelf = shelf
        coordinator.wanted = page
        coordinator.attach(in: container)
    }
    static func dismantleUIView(_ container: CanvasContainer, coordinator: Coordinator) {
        coordinator.release(to: coordinator.shelf)
    }
    func makeCoordinator() -> Coordinator { Coordinator(shelf: shelf, onHeight: onHeight) }

    /// Measurement only: pages loaded before, so loading one again is counted.
    @MainActor fileprivate static var loaded: Set<String> = []

    fileprivate static func makeWebView() -> WKWebView {
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
        var shelf: ViewShelf<WKWebView>?
        var onHeight: (CGFloat) -> Void
        /// The page the row shows now, laid out once the row's width is known.
        var wanted: CanvasPage?
        private(set) var pageId: String?
        private weak var view: WKWebView?
        private var observation: NSKeyValueObservation?
        init(shelf: ViewShelf<WKWebView>?, onHeight: @escaping (CGFloat) -> Void) {
            self.shelf = shelf
            self.onHeight = onHeight
        }
        /// Puts the wanted page in `container` once it has its real width. Loaded at no width, the
        /// page would lay out one word fragment a line and report that height, and the row would
        /// open at it, then jump as the width arrived.
        func attach(in container: CanvasContainer) {
            guard let page = wanted, pageId != page.id, container.bounds.width >= 1 else { return }
            release(to: shelf)
            let view: WKWebView
            if let kept = shelf?.take(page.id) {
                view = kept
            } else {
                view = MeasuredCanvas.makeWebView()
                PerfProbe.add("canvas.loads", 1)
                if PerfProbe.enabled, !MeasuredCanvas.loaded.insert(page.id).inserted { PerfProbe.add("canvas.reloads", 1) }
                view.frame = container.bounds
                view.loadHTMLString(page.document, baseURL: nil)
            }
            view.navigationDelegate = self
            view.frame = container.bounds
            container.addSubview(view)
            show(view, page: page.id)
        }
        /// Watches the page's reported height, starting with the one a kept view already has.
        func show(_ view: WKWebView, page: String) {
            self.view = view
            pageId = page
            // Reported after the update that showed the view, never during it.
            observation = view.observe(\.title, options: [.initial, .new]) { [weak self] view, _ in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self, self.view === view, view.bounds.width >= 1,
                              let reported = pageHeight(view.title ?? "") else { return }
                        self.onHeight(reported)
                    }
                }
            }
        }
        /// The row went off screen (or shows another page): its view goes back on the shelf.
        func release(to shelf: ViewShelf<WKWebView>?) {
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

/// The canvas row's host view. Its web view always fills it, and it says each time it lays out
/// at a real width, so the page loads only once that width is known.
final class CanvasContainer: UIView {
    var widthKnown: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        for view in subviews where view.frame != bounds { view.frame = bounds }
        if bounds.width >= 1 { widthKnown?() }
    }
}

/// The height the outer document puts in its title, `ace.html.height:<1–10000>`.
nonisolated func pageHeight(_ title: String) -> CGFloat? {
    guard title.hasPrefix("ace.html.height:"), let value = Int(title.dropFirst("ace.html.height:".count)),
          (1...10_000).contains(value) else { return nil }
    return CGFloat(value)
}
