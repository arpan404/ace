import CoreGraphics
import Foundation
import ImageIO

/// The still a subscribe's reply brings when its pictures come by the media connection (ADR
/// 0149, "a poster"): a viewport-sized JPEG of 10–20 KB, shown until the first live picture so a
/// phone on 3G sees the page within about a second. It is taken out of the reply on the socket's
/// queue and drawn natively; the reply goes on to the script without it.
struct LivePoster: @unchecked Sendable {
    enum Kind: Sendable, Equatable { case browser, screen, device }
    let kind: Kind
    let image: CGImage
}

/// A subscribe reply with its poster taken out. Pure.
enum PosterReply {
    /// The replies whose `media` may carry a poster, by the live view they answer.
    private static let kinds: [String: LivePoster.Kind] = [
        "browser.result": .browser, "screen.result": .screen, "devices.result": .device,
    ]
    /// The schema's bounds (`MediaPoster`): sides in 1...8192, at most 64 KiB of base64.
    private static let maxSide = 8192
    private static let maxBase64 = 64 * 1024

    struct Taken: Equatable {
        let kind: LivePoster.Kind
        let width: Int
        let height: Int
        let jpeg: Data
    }

    /// `text` without its poster and the poster's JPEG, or `text` untouched with nil when it has
    /// none: another message, no `media.poster`, or a poster outside the schema's bounds (which
    /// is dropped, never passed on).
    static func take(_ text: String) -> (text: String, poster: Taken?) {
        // Cheap first: nearly every message is skipped without parsing.
        guard text.contains(#""poster""#), text.contains(#""media""#),
              var message = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              let type = message["type"] as? String, let kind = kinds[type],
              var media = message["media"] as? [String: Any],
              let poster = media.removeValue(forKey: "poster") else { return (text, nil) }
        message["media"] = media
        guard let rewritten = try? JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes]) else {
            return (text, nil)
        }
        let without = String(decoding: rewritten, as: UTF8.self)
        guard let fields = poster as? [String: Any],
              let width = fields["width"] as? Int, let height = fields["height"] as? Int,
              (1...maxSide).contains(width), (1...maxSide).contains(height),
              let base64 = fields["jpeg"] as? String, !base64.isEmpty, base64.utf8.count <= maxBase64,
              let jpeg = Data(base64Encoded: base64) else { return (without, nil) }
        return (without, Taken(kind: kind, width: width, height: height, jpeg: jpeg))
    }

    /// The poster's picture, decoded here (the socket's queue, never the main thread). Nil when
    /// the bytes aren't an image.
    static func decode(_ taken: Taken) -> LivePoster? {
        guard let source = CGImageSourceCreateWithData(taken.jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { return nil }
        return LivePoster(kind: taken.kind, image: image)
    }
}

/// Whether a live surface shows its poster: from the moment one arrives until its first live
/// picture is drawn, and never again for that view after. Pure.
struct PosterGate {
    private(set) var shown: CGImage?
    private var pictured = false
    /// A poster arrived: true when the surface should show it now.
    mutating func offer(_ image: CGImage) -> Bool {
        guard !pictured else { return false }
        shown = image
        return true
    }
    /// A live picture was drawn: true when a shown poster should go.
    mutating func pictureDrawn() -> Bool {
        pictured = true
        guard shown != nil else { return false }
        shown = nil
        return true
    }
}

/// The newest poster for a view, from the socket's queue to the surface's display tick.
final class LatestPoster: @unchecked Sendable {
    private let lock = NSLock()
    private var image: CGImage?
    func put(_ image: CGImage) { lock.withLock { self.image = image } }
    func take() -> CGImage? { lock.withLock { defer { image = nil }; return image } }
}
