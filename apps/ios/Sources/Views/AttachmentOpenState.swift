import Foundation

/// What a message attachment is showing, or about to show: one pending open and one presentation
/// in a single value, so a newer tap supersedes an older one and only the latest ever presents.
/// Pure: the view reads files and cleans them up from what these calls answer.
struct AttachmentOpenState: Equatable {
    enum Route: Equatable {
        case video(name: String, mimeType: String)
        case document
    }
    enum Presentation: Equatable {
        case video(MessageVideoTarget)
        case document(URL)

        var url: URL {
            switch self {
            case let .video(target): target.url
            case let .document(url): url
            }
        }
    }
    struct Pending: Equatable {
        let token: Int
        let name: String
    }

    private(set) var pending: Pending?
    private(set) var presentation: Presentation?
    private var issued = 0

    /// Starts an open. Any earlier pending open is superseded: its completion will be refused.
    mutating func begin(name: String) -> Int {
        issued += 1
        pending = Pending(token: issued, name: name)
        return issued
    }

    /// The open `token` finished with a kept copy. Presents it when it is still the latest open;
    /// otherwise returns nil and the caller removes the copy it made.
    mutating func complete(_ token: Int, kept url: URL, as route: Route) -> Presentation? {
        guard pending?.token == token else { return nil }
        pending = nil
        let shown: Presentation = switch route {
        case let .video(name, mimeType): .video(MessageVideoTarget(name: name, url: url, mimeType: mimeType))
        case .document: .document(url)
        }
        presentation = shown
        return shown
    }

    /// The open `token` failed. True when it was still the latest, so its problem is worth showing.
    mutating func fail(_ token: Int) -> Bool {
        guard pending?.token == token else { return false }
        pending = nil
        return true
    }

    /// The presentation closed (Done, swipe down, Quick Look dismissed). Answers the copy it owned.
    mutating func close() -> URL? {
        defer { presentation = nil }
        return presentation?.url
    }
}

/// Which videos the phone plays and the type it plays them under.
enum AttachmentVideoType {
    private static let known = ["mp4": "video/mp4", "m4v": "video/x-m4v", "mov": "video/quicktime"]

    /// The video type of a file sent under a generic type, from its extension; nil when it isn't a known video.
    static func fromExtension(_ name: String) -> String? {
        known[(name as NSString).pathExtension.lowercased()]
    }

    static func isGeneric(_ mimeType: String?) -> Bool {
        guard let mimeType, !mimeType.isEmpty else { return true }
        return mimeType == "application/octet-stream"
    }
}
