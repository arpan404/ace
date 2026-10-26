import AVKit
import SwiftUI

/// Media the daemon fetched for GitHub text, kept while the app runs so a page redrawn or opened
/// again shows it at once. Bytes only ever come from the daemon (ADR 0096).
@MainActor final class ForgeMediaCache {
    static let shared = ForgeMediaCache()
    private let cache = NSCache<NSString, Box>()
    final class Box { let value: ForgeMediaBytes; init(_ value: ForgeMediaBytes) { self.value = value } }
    init() { cache.totalCostLimit = 96 << 20 }

    func load(_ url: String, role: String, scope: ForgeRichScope) async -> ForgeMediaBytes? {
        let key = "\(scope.project)|\(role)|\(url)" as NSString
        if let kept = cache.object(forKey: key) { return kept.value }
        guard let value = await scope.media(url, role: role) else { return nil }
        // Only answers that won't change are kept; a failure is asked again next time.
        if value.state != "unavailable" { cache.setObject(Box(value), forKey: key, cost: value.data?.utf8.count ?? 64) }
        return value
    }
}

/// An image in GitHub text: its dark source in dark mode when it has one, sized as the text
/// asked (never wider than the column), with its alt text read aloud. What can't be shown says
/// why in place, with the alt text.
struct ForgeImageBlock: View {
    let image: ForgeImageRef
    let scope: ForgeRichScope
    @Environment(\.colorScheme) private var scheme
    @State private var media: ForgeMediaBytes?
    @State private var svgHeight: CGFloat = 80

    private var source: String { scheme == .dark ? (image.dark ?? image.src) : image.src }

    var body: some View {
        content
            .frame(maxWidth: image.width.map { CGFloat($0) } ?? .infinity, alignment: .leading)
            .accessibilityLabel(image.alt.isEmpty ? "Image" : image.alt)
            .task(id: source) { media = await ForgeMediaCache.shared.load(source, role: "image", scope: scope) }
    }

    @ViewBuilder private var content: some View {
        if let media, media.state == "ready", let data = media.data.flatMap({ Data(base64Encoded: $0) }) {
            if let picture = UIImage(data: data) {
                Image(uiImage: picture).resizable().aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: AceTheme.Radii.sm, style: .continuous))
            } else if media.mimeType == "image/svg+xml" {
                ForgeWebSnippet(html: "<img alt=\"\" src=\"data:image/svg+xml;base64,\(media.data ?? "")\">", height: $svgHeight)
                    .frame(height: svgHeight)
            } else {
                unavailable("Can't be shown here")
            }
        } else if let media, media.state != "ready" {
            unavailable(media.reason ?? "Couldn't load it")
        } else {
            RoundedRectangle(cornerRadius: AceTheme.Radii.sm, style: .continuous).fill(AceTheme.Colours.fill)
                .aspectRatio(aspect, contentMode: .fit)
                .frame(maxHeight: 240)
        }
    }

    /// Space reserved before the bytes arrive, from the size the text or the daemon gave.
    private var aspect: CGFloat {
        if let width = image.width, let height = image.height, height > 0 { return width / height }
        return 16 / 9
    }

    private func unavailable(_ reason: String) -> some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            AceIcon(.image, size: 14, relativeTo: .footnote)
            Text(image.alt.isEmpty ? reason : "\(image.alt) · \(reason)").lineLimit(2)
        }
        .meta(AceTheme.Colours.subtleForeground)
    }
}

/// A link alone on its line that GitHub may show as a player: a video plays inline (MP4 and
/// QuickTime natively, WebM in an offline web view); anything else stays the link it is.
struct ForgeMediaLinkBlock: View {
    let url: String
    let runs: [ForgeRun]
    let scope: ForgeRichScope
    @State private var media: ForgeMediaBytes?
    @State private var player: AVPlayer?
    @State private var webHeight: CGFloat = 200

    var body: some View {
        content
            .task(id: url) {
                media = await ForgeMediaCache.shared.load(url, role: "link", scope: scope)
                player = media.flatMap(Self.playable).map { AVPlayer(url: $0) }
            }
    }

    @ViewBuilder private var content: some View {
        if let player {
            VideoPlayer(player: player)
                .aspectRatio(aspect, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: AceTheme.Radii.sm, style: .continuous))
                .accessibilityLabel("Video")
        } else if let media, media.state == "ready", media.kind == "video", let data = media.data {
            ForgeWebSnippet(html: "<video controls playsinline src=\"data:\(media.mimeType ?? "video/webm");base64,\(data)\"></video>", height: $webHeight)
                .frame(height: webHeight)
                .accessibilityLabel("Video")
        } else if let media, media.state == "ready", media.kind == "image" {
            ForgeImageBlock(image: ForgeImageRef(src: url, dark: nil, alt: "", width: media.width, height: media.height), scope: scope)
        } else {
            ForgeRunsText(runs: runs)
        }
    }

    private var aspect: CGFloat {
        if let width = media?.width, let height = media?.height, height > 0 { return width / height }
        return 16 / 9
    }

    /// MP4 and QuickTime bytes written where AVKit can play them; nil for anything else.
    private static func playable(_ media: ForgeMediaBytes) -> URL? {
        guard media.state == "ready", media.kind == "video", let data = media.data.flatMap({ Data(base64Encoded: $0) }) else { return nil }
        let ext = switch media.mimeType { case "video/mp4": "mp4"; case "video/quicktime": "mov"; default: "" }
        guard !ext.isEmpty else { return nil }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("forge-\(data.hashValue).\(ext)")
        if !FileManager.default.fileExists(atPath: file.path) { try? data.write(to: file, options: .atomic) }
        return file
    }
}
