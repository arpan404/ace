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
            if PerfProbe.enabled, !Self.loaded.insert(page.id).inserted { PerfProbe.add("canvas.reloads", 1) }
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

    /// Measurement only: pages loaded before, so loading one again is counted.
    @MainActor private static var loaded: Set<String> = []

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
        let shelf: ViewShelf<WKWebView>?
        var onHeight: (CGFloat) -> Void
        private(set) var pageId: String?
        private weak var view: WKWebView?
        private var observation: NSKeyValueObservation?
        init(shelf: ViewShelf<WKWebView>?, onHeight: @escaping (CGFloat) -> Void) {
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

/// The height the outer document puts in its title, `ace.html.height:<1–10000>`.
nonisolated func pageHeight(_ title: String) -> CGFloat? {
    guard title.hasPrefix("ace.html.height:"), let value = Int(title.dropFirst("ace.html.height:".count)),
          (1...10_000).contains(value) else { return nil }
    return CGFloat(value)
}
