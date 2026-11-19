import SwiftUI
import UIKit
import WebKit

/// Published media as the bridge answers `native.media`: a sandboxed page or an image's pixels.
enum PublishedMedia {
    case page(CanvasPage)
    case picture(UIImage)
}

private struct PublishedMediaReply: Decodable { let kind: String; let document: String?; let source: String?; let data: String? }

/// Reads one thread's published media through the owning connection, keeping what it read so a
/// row that scrolls back into view draws at once instead of fetching again, and its pages'
/// heights and loaded views (`canvases`) so a page comes back at its height without loading.
@MainActor final class PublishedMediaSource {
    let model: ClientModel
    let threadId: String
    /// Pixels may be large, so the system may drop them under memory pressure.
    private let cache = NSCache<NSString, Box>()
    /// Pages are a few kilobytes of HTML: kept in order and dropped oldest first, never at the
    /// system's whim, so a page read once is never fetched again while the thread is open.
    private var pages: [NSString: CanvasPage] = [:]
    private var pageOrder: [NSString] = []
    private static let maxPages = 64
    /// Enough loaded pages that reading back over a long thread's charts never loads one again.
    let canvases = ViewShelf<WKWebView>(maxKept: 16)
    private final class Box { let media: PublishedMedia; init(_ media: PublishedMedia) { self.media = media } }

    init(model: ClientModel, threadId: String) {
        self.model = model
        self.threadId = threadId
        cache.countLimit = 24
    }

    func cached(_ itemId: String, scheme: ColorScheme) -> PublishedMedia? {
        let key = key(itemId, scheme)
        if let page = pages[key] { return .page(page) }
        return cache.object(forKey: key)?.media
    }

    /// Reads in flight, shared by every row that asks, and never cancelled with a row: a row
    /// flung past before its media arrives still leaves it here for when it comes back.
    private var reading: [NSString: Task<PublishedMedia, Error>] = [:]

    func load(_ itemId: String, scheme: ColorScheme) async throws -> PublishedMedia {
        if let hit = cached(itemId, scheme: scheme) { return hit }
        let key = key(itemId, scheme)
        if let pending = reading[key] { return try await pending.value }
        let read = Task<PublishedMedia, Error> { @MainActor in
            defer { reading[key] = nil }
            return try await fetch(itemId, scheme: scheme)
        }
        reading[key] = read
        return try await read.value
    }

    /// Measurement only: what was fetched before, so a second fetch of it is counted.
    private var fetched: Set<NSString> = []

    private func fetch(_ itemId: String, scheme: ColorScheme) async throws -> PublishedMedia {
        PerfProbe.add("media.fetches", 1)
        if PerfProbe.enabled, !fetched.insert(key(itemId, scheme)).inserted { PerfProbe.add("media.refetches", 1) }
        let reply = try await model.service(["type": "native.media", "threadId": threadId, "itemId": itemId, "scheme": scheme == .dark ? "dark" : "light"], as: PublishedMediaReply.self)
        let media: PublishedMedia
        if reply.kind == "html", let html = reply.document { media = .page(CanvasPage(document: html, source: reply.source ?? "")) }
        else if let encoded = reply.data, let data = Data(base64Encoded: encoded), let image = UIImage(data: data) {
            media = .picture(await image.byPreparingForDisplay() ?? image)
        } else { throw ServiceFailure(message: "The attachment couldn't be decoded.") }
        let key = key(itemId, scheme)
        if case .page(let page) = media {
            if pages.updateValue(page, forKey: key) == nil { pageOrder.append(key) }
            while pageOrder.count > Self.maxPages { pages[pageOrder.removeFirst()] = nil }
        } else {
            cache.setObject(Box(media), forKey: key)
        }
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
/// the image, or the full-screen icon above a page, opens it whole.
struct PublishedMediaRow: View {
    let row: TranscriptRow
    let open: () -> Void
    @Environment(\.publishedMedia) private var source
    @Environment(\.colorScheme) private var scheme
    @State private var media: PublishedMedia?
    @State private var failed = false

    /// What the row draws: what it loaded, or what the thread already holds, so a row coming back
    /// into view draws its media in its first layout rather than a placeholder.
    private var shown: PublishedMedia? { media ?? source?.cached(row.id, scheme: scheme) }

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
            if source.cached(row.id, scheme: scheme) != nil { return }
            do { media = try await source.load(row.id, scheme: scheme); failed = false }
            catch { if !Task.isCancelled { failed = true } }
        }
    }

    private var picture: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
            if case .picture(let image) = shown {
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
            // A small glass circle, so it reads as a button without competing with the page.
            Button(action: open) {
                AceIcon(.arrowsOutSimple, size: AceDesign.Size.icon, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .frame(width: Self.expandSize, height: Self.expandSize)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .aceGlass(in: Circle(), interactive: true)
            .padding((AceDesign.Size.tap - Self.expandSize) / 2)
            .contentShape(Rectangle())
            .accessibilityLabel("Open \(row.text) full screen")
            if case .page(let page) = shown {
                InlineCanvas(page: page, itemId: row.id, title: row.text, shelf: source?.canvases)
            } else {
                AceShape.block.fill(AceTheme.Colours.fill)
                    // A page read before keeps its place while it is fetched again.
                    .frame(maxWidth: .infinity).frame(height: source?.canvases.height(row.id) ?? InlineCanvas.placeholderHeight)
                    .accessibilityLabel("Loading \(row.text)")
            }
        }
        .frame(maxWidth: .infinity)
    }

    private static let maxImageHeight: CGFloat = 420
    private static let expandSize = AceDesign.Size.pill
    private static let placeholderHeight = InlineCanvas.placeholderHeight
}
