import Foundation
import ImageIO
import Observation
import UIKit

/// A project's mark as the bridge sends it once per project (`bridge/project-looks.ts`): an image
/// to try first (a data: URI or an https URL), then a glyph by its icon name. A project the bridge
/// sends nothing for draws the initials its rows carry.
struct ProjectLookPatch: Decodable, Sendable, Equatable {
    let image: String?
    let glyph: String?
}

/// What a row's project mark draws, resolved once when the look arrives: the glyph as an ace icon
/// (unknown names fall back to initials) and the shared, cached artwork for the image.
@MainActor struct ProjectMarkLook: Equatable {
    let glyph: AceIcon.Name?
    let artwork: ProjectArtwork?

    init(glyph: AceIcon.Name?, artwork: ProjectArtwork?) { self.glyph = glyph; self.artwork = artwork }
    init(_ patch: ProjectLookPatch) {
        glyph = patch.glyph.flatMap(AceIcon.Name.init(rawValue:))
        artwork = patch.image.flatMap(ProjectArtwork.shared(for:))
    }
    nonisolated static func == (a: Self, b: Self) -> Bool { a.glyph == b.glyph && a.artwork === b.artwork }
}

/// One project image, decoded or fetched once and kept for every row and machine that shows it.
/// A data: URI decodes off the main thread; an https icon loads when a row first shows it. The
/// row draws the glyph or initials until it is ready, and keeps them if it fails.
@MainActor @Observable final class ProjectArtwork {
    enum State: Equatable { case idle, loading, ready, failed }
    let source: String
    private(set) var image: UIImage?
    private(set) var state = State.idle

    private init(source: String) { self.source = source }

    /// Images are small and projects few; the cache is bounded anyway.
    @ObservationIgnored private static var cache: [String: ProjectArtwork] = [:]
    private static let limit = 256

    /// The artwork for a source, shared by every look that names it.
    static func shared(for source: String) -> ProjectArtwork? {
        guard !source.isEmpty else { return nil }
        if let known = cache[source] { return known }
        if cache.count >= limit { cache.removeAll() }
        let artwork = ProjectArtwork(source: source)
        cache[source] = artwork
        return artwork
    }

    /// Starts decoding or fetching once; later calls do nothing.
    func load() {
        guard state == .idle else { return }
        state = .loading
        let source = source
        Task { [weak self] in
            let image = await Self.read(source)
            self?.image = image
            self?.state = image == nil ? .failed : .ready
        }
    }

    /// Fetched icons: no cookies or cache shared with anything else, and a short wait.
    nonisolated private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.httpCookieAcceptPolicy = .never
        return URLSession(configuration: configuration)
    }()
    nonisolated private static let largestDownload = 1 << 20

    nonisolated private static func read(_ source: String) async -> UIImage? {
        if source.hasPrefix("data:") {
            return await Task.detached(priority: .utility) {
                guard let comma = source.firstIndex(of: ","),
                      let data = Data(base64Encoded: String(source[source.index(after: comma)...])) else { return nil }
                return thumbnail(data)
            }.value
        }
        // Only https: the app never loads plain http, and other schemes are not images.
        guard let url = URL(string: source), url.scheme?.lowercased() == "https" else { return nil }
        guard let (data, response) = try? await session.data(from: url),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              data.count <= largestDownload else { return nil }
        return await Task.detached(priority: .utility) { thumbnail(data) }.value
    }

    /// A small copy for a 16pt mark, so a large upload never sits decoded in memory.
    nonisolated private static func thumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 96,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// A machine's mark on inbox rows: its chosen icon, with its name for VoiceOver.
struct MachineMark: Equatable {
    let name: String
    let glyph: AceIcon.Name
}
