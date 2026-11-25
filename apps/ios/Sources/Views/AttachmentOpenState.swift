import Foundation

/// What a message's attachments are showing, or about to show: one pending open, one presentation
/// and at most one replacement waiting behind it, in a single value. A newer tap supersedes an
/// older one, and a replacement waits until the outgoing viewer has dismissed, so a late dismissal
/// never closes or deletes what came after it. Pure: the view reads and deletes files from what
/// these calls answer.
struct AttachmentOpenState: Equatable {
    enum Route: Equatable {
        case video(name: String, mimeType: String)
        case document
    }
    enum Presentation: Equatable {
        case images(AttachmentTarget)
        case video(MessageVideoTarget)
        case document(URL)

        /// The temp copy this presentation owns; pictures are read into memory and own none.
        var url: URL? {
            switch self {
            case .images: nil
            case let .video(target): target.url
            case let .document(url): url
            }
        }
    }
    struct Shown: Equatable {
        let id: Int
        let presentation: Presentation
        /// Asked to close because a replacement is waiting; its dismissal promotes that replacement.
        var closing = false
    }
    struct Pending: Equatable {
        let token: Int
        let name: String
    }

    private(set) var pending: Pending?
    private(set) var shown: Shown?
    private(set) var queued: Presentation?
    private var issued = 0
    private var shownCount = 0
    private var sharing = false
    private var held: [URL] = []

    /// What a viewer should be showing now: nothing while the outgoing one is closing.
    var visible: Presentation? { shown.flatMap { $0.closing ? nil : $0.presentation } }

    /// Starts an open. Any earlier pending open is superseded: its completion will be refused.
    mutating func begin(name: String) -> Int {
        issued += 1
        pending = Pending(token: issued, name: name)
        return issued
    }

    /// Shows pictures, superseding any pending open. Answers copies to delete.
    mutating func showImages(_ target: AttachmentTarget) -> [URL] {
        issued += 1
        pending = nil
        return present(.images(target))
    }

    /// The open `token` finished with a kept copy for `line`. Presents it when it is still the
    /// latest open; otherwise nothing changes. Answers copies to delete: `url` itself when it was
    /// superseded, or a replacement it displaced.
    mutating func complete(_ token: Int, kept url: URL, line: AttachmentLine, replyMimeType: String) -> [URL] {
        guard pending?.token == token else { return [url] }
        pending = nil
        switch line.route(replyMimeType: replyMimeType) {
        case let .video(name, mimeType): return present(.video(MessageVideoTarget(name: name, url: url, mimeType: mimeType)))
        case .document: return present(.document(url))
        }
    }

    /// The open `token` failed. True when it was still the latest, so its problem is worth showing.
    mutating func fail(_ token: Int) -> Bool {
        guard pending?.token == token else { return false }
        pending = nil
        return true
    }

    /// The viewer `id` closed. A viewer that isn't the current one (already replaced) changes
    /// nothing. Answers copies to delete now; a copy waits while a share is in progress.
    mutating func dismissed(_ id: Int) -> [URL] {
        guard let current = shown, current.id == id else { return [] }
        shown = nil
        var owned = [URL]()
        if let url = current.presentation.url { owned.append(url) }
        if let next = queued {
            queued = nil
            shownCount += 1
            shown = Shown(id: shownCount, presentation: next)
        }
        return settle(owned)
    }

    /// The route went away: nothing pending may present, and a waiting replacement never will.
    mutating func leave() -> [URL] {
        issued += 1
        pending = nil
        defer { queued = nil }
        return queued?.url.map { [$0] } ?? []
    }

    /// A share of the player's copy started or ended. Ending releases copies held for it.
    mutating func shareChanged(_ active: Bool) -> [URL] {
        sharing = active
        guard !active else { return [] }
        defer { held = [] }
        return held
    }

    private mutating func present(_ next: Presentation) -> [URL] {
        guard shown != nil else {
            shownCount += 1
            shown = Shown(id: shownCount, presentation: next)
            return []
        }
        shown?.closing = true
        let displaced = queued?.url
        queued = next
        return displaced.map { [$0] } ?? []
    }

    private mutating func settle(_ urls: [URL]) -> [URL] {
        guard sharing else { return urls }
        held += urls
        return []
    }
}

extension AttachmentLine {
    /// Where this attachment opens: a video the phone plays under the type it plays as, or Quick Look.
    func route(replyMimeType: String) -> AttachmentOpenState.Route {
        plays ? .video(name: name, mimeType: genericVideoType ?? mimeType ?? replyMimeType) : .document
    }
}

/// Which videos the phone plays and the type it plays them under.
enum AttachmentVideoType {
    private static let known = ["mp4": "video/mp4", "m4v": "video/x-m4v", "mov": "video/quicktime"]

    /// The video type of a file sent under a generic type, from its extension; nil when it isn't a known video.
    static func fromExtension(_ name: String) -> String? {
        known[(name as NSString).pathExtension.lowercased()]
    }

    /// Absent or `application/octet-stream`: the sender didn't say what the file is.
    static func isGeneric(_ mimeType: String?) -> Bool {
        guard let mimeType, !mimeType.isEmpty else { return true }
        return mimeType == "application/octet-stream"
    }
}
