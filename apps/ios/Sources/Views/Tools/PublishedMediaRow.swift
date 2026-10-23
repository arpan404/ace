import SwiftUI
import UIKit
import WebKit

/// Published media as the bridge answers `native.media`: a sandboxed page or an image's pixels.
enum PublishedMedia {
    case page(String)
    case picture(UIImage)
}

private struct PublishedMediaReply: Decodable { let kind: String; let document: String?; let data: String? }

/// Reads one thread's published media through the owning connection, keeping what it read so a
/// row that scrolls back into view draws at once instead of fetching again.
@MainActor final class PublishedMediaSource {
    let model: ClientModel
    let threadId: String
    private let cache = NSCache<NSString, Box>()
    private final class Box { let media: PublishedMedia; init(_ media: PublishedMedia) { self.media = media } }

    init(model: ClientModel, threadId: String) {
        self.model = model
        self.threadId = threadId
        cache.countLimit = 24
    }

    func cached(_ itemId: String, scheme: ColorScheme) -> PublishedMedia? {
        cache.object(forKey: key(itemId, scheme))?.media
    }

    func load(_ itemId: String, scheme: ColorScheme) async throws -> PublishedMedia {
        if let hit = cached(itemId, scheme: scheme) { return hit }
        let reply = try await model.service(["type": "native.media", "threadId": threadId, "itemId": itemId, "scheme": scheme == .dark ? "dark" : "light"], as: PublishedMediaReply.self)
        let media: PublishedMedia
        if reply.kind == "html", let html = reply.document { media = .page(html) }
        else if let encoded = reply.data, let data = Data(base64Encoded: encoded), let image = UIImage(data: data) {
            media = .picture(await image.byPreparingForDisplay() ?? image)
        } else { throw ServiceFailure(message: "The attachment couldn't be decoded.") }
        cache.setObject(Box(media), forKey: key(itemId, scheme))
        return media
    }

    /// Pages carry the theme; pixels are the same in either scheme.
    private func key(_ itemId: String, _ scheme: ColorScheme) -> NSString {
        "\(itemId)|\(scheme == .dark ? "dark" : "light")" as NSString
    }
}

extension EnvironmentValues {
    @Entry var publishedMedia: PublishedMediaSource? = nil
}

/// Lets a thread's transcript draw its published media inline, with one cache per thread.
struct PublishedMediaScope: ViewModifier {
    let model: ClientModel
    let threadId: String
    @State private var source: PublishedMediaSource?
    func body(content: Content) -> some View {
        content
            .environment(\.publishedMedia, source?.threadId == threadId ? source : nil)
            .task(id: threadId) { if source?.threadId != threadId { source = PublishedMediaSource(model: model, threadId: threadId) } }
    }
}

extension View {
    func publishedMedia(model: ClientModel, threadId: String) -> some View {
        modifier(PublishedMediaScope(model: model, threadId: threadId))
    }
}

/// An image or visualization the agent published, drawn in the reply at the column's width like
/// the web: an image fitted with its caption beneath, a page at its own content height. Tapping
/// the image, or Full screen above a page, opens it whole.
struct PublishedMediaRow: View {
    let row: TranscriptRow
    let open: () -> Void
    @Environment(\.publishedMedia) private var source
    @Environment(\.colorScheme) private var scheme
    @State private var media: PublishedMedia?
    @State private var failed = false

    var body: some View {
        Group {
            if source == nil || failed {
                QuietLink(icon: row.type == "html" ? .chartBarHorizontal : .image, title: row.text, action: open)
            } else if row.type == "html" {
                page
            } else {
                picture
            }
        }
        .accessibilityIdentifier("media.\(row.id)")
        .task(id: scheme) {
            guard let source else { return }
            if let hit = source.cached(row.id, scheme: scheme) { media = hit; return }
            do { media = try await source.load(row.id, scheme: scheme); failed = false }
            catch { if !Task.isCancelled { failed = true } }
        }
    }

    private var picture: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
            if case .picture(let image) = media {
                Button(action: open) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: image.size.width, maxHeight: Self.maxImageHeight, alignment: .leading)
                        .clipShape(AceShape.block)
                        .contentShape(AceShape.block)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.text)
                .accessibilityAddTraits(.isImage)
            } else {
                AceShape.block.fill(AceTheme.Colours.fill)
                    .frame(maxWidth: .infinity).frame(height: Self.placeholderHeight)
                    .accessibilityLabel("Loading \(row.text)")
            }
            if let caption = row.detail, !caption.isEmpty {
                Text(caption)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var page: some View {
        VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
            Button("Full screen", action: open)
                .buttonStyle(.plain)
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(minHeight: AceTheme.Spacing.xxl + AceTheme.Spacing.xs)
                .accessibilityLabel("Open \(row.text) full screen")
            if case .page(let document) = media {
                InlineCanvas(document: document, title: row.text)
            } else {
                AceShape.block.fill(AceTheme.Colours.fill)
                    .frame(maxWidth: .infinity).frame(height: Self.placeholderHeight)
                    .accessibilityLabel("Loading \(row.text)")
            }
        }
        .frame(maxWidth: .infinity)
    }

    private static let maxImageHeight: CGFloat = 420
    private static let placeholderHeight: CGFloat = 160
}

/// A page inline in the transcript: as tall as its content, which the trusted outer document
/// reports through its title (the authored page, in its own opaque-origin frame, cannot set it).
/// The transcript scrolls, not the page; it keeps its own taps and gestures.
private struct InlineCanvas: View {
    let document: String
    let title: String
    @State private var height: CGFloat = 160
    var body: some View {
        MeasuredCanvas(document: document, height: $height)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .accessibilityLabel(title)
    }
}

private struct MeasuredCanvas: UIViewRepresentable {
    let document: String
    @Binding var height: CGFloat
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.accessibilityIdentifier = "canvas.inline"
        context.coordinator.watch(view)
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.height = $height
        guard context.coordinator.loadedDocument != document else { return }
        context.coordinator.loadedDocument = document
        view.loadHTMLString(document, baseURL: nil)
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { coordinator.stop() }
    func makeCoordinator() -> Coordinator { Coordinator(height: $height) }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedDocument = ""
        var height: Binding<CGFloat>
        private var observation: NSKeyValueObservation?
        init(height: Binding<CGFloat>) { self.height = height }
        func watch(_ view: WKWebView) {
            observation = view.observe(\.title, options: [.new]) { [weak self] view, _ in
                MainActor.assumeIsolated {
                    guard let self, let reported = pageHeight(view.title ?? "") else { return }
                    if abs(self.height.wrappedValue - reported) >= 1 { self.height.wrappedValue = reported }
                }
            }
        }
        func stop() { observation?.invalidate(); observation = nil }
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
