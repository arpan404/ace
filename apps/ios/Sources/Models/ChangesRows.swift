import Foundation

/// The Changes sheet as the bridge shapes it (`bridge/CHANGES-CONTRACT.md`): scopes, the file
/// list and tree, open files paged in, and the local review. Swift draws it; it never diffs.
struct ChangesScope: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let turn: Int?
    var workingTree: Bool?
}

struct ChangesTreeRow: Codable, Sendable, Equatable, Identifiable {
    /// `folder` or `file`.
    let kind: String
    let key: String
    let name: String
    let depth: Int
    let additions: Int
    let deletions: Int
    let files: Int?
    let index: Int?
    var id: String { key }
}

/// One open file's header; its rows come in pages under the same `file` id.
struct ChangesFileHeader: Codable, Sendable, Equatable {
    let file: String
    let path: String
    let version: String
    /// `loading`, `ready` or `error`.
    let state: String
    let message: String
    let binary: Bool
    let pages: Int
    let rows: Int
    let remaining: Int?
    let complete: Bool
    let cut: Bool
    let empty: Bool
    let viewed: Bool
}

struct ChangesRow: Codable, Sendable, Equatable, Identifiable {
    let i: Int
    /// `add`, `del`, `context` or `fold`.
    let kind: String
    let old: Int?
    let new: Int?
    let text: String
    let length: Int
    let clipped: Bool
    let count: Int?
    var id: Int { i }
    /// The line number a comment anchors to, and on which side.
    var anchor: (side: String, line: Int)? {
        if kind == "del", let old { return ("old", old) }
        if kind == "add" || kind == "context", let new { return ("new", new) }
        return nil
    }
}

struct ChangesPair: Codable, Sendable, Equatable {
    /// `fold` or `pair`.
    let kind: String
    let fold: ChangesRow?
    let left: ChangesRow?
    let right: ChangesRow?
}

struct ChangesPage: Codable, Sendable, Equatable {
    let file: String
    let path: String
    let version: String
    let index: Int
    let layout: String
    let lines: [ChangesRow]?
    let pairs: [ChangesPair]?
}

struct ChangesWholeLine: Codable, Sendable, Equatable {
    let file: String
    let path: String
    let version: String
    let row: ChangesRow
}

struct ChangesReview: Codable, Sendable, Equatable {
    struct Session: Codable, Sendable, Equatable { let id: String; let status: String }
    struct Draft: Codable, Sendable, Equatable, Identifiable {
        let key: String
        let path: String
        let side: String
        let start: Int
        let end: Int
        let text: String
        let suggestion: String?
        /// `draft`, `sending`, `sent`, `failed`, `resolving` or `resolved`.
        let state: String
        let error: String?
        let anchor: String?
        let applied: Bool
        let sent: Bool
        let createdAt: Double
        var id: String { key }
        var pending: Bool { state == "draft" || state == "failed" }
        var lines: String { start == end ? "Line \(start)" : "Lines \(start)–\(end)" }
    }
    let session: Session?
    let refreshing: Bool
    let message: String
    /// Why this phone can't keep the review right now (a failed read or save), else "".
    let storage: String?
    let pending: Int
    let open: Int
    let resolved: Int
    let hidden: Int
    let drafts: [Draft]
}

struct ChangesReplies: Codable, Sendable, Equatable {
    struct Reply: Codable, Sendable, Equatable, Identifiable { let id: String; let text: String }
    let key: String
    let state: String
    let message: String
    let replies: [Reply]
}

struct ChangesNotice: Codable, Sendable, Equatable {
    let requestId: String
    let action: String
    let ok: Bool
    let message: String
}

/// Everything but the summary, which keeps its own case for the sheet's open trace.
enum ChangesPatch: Sendable {
    case tree([ChangesTreeRow])
    case file(ChangesFileHeader)
    case page(ChangesPage)
    case line(ChangesWholeLine)
    case review(ChangesReview)
    case replies(ChangesReplies)
    case notice(ChangesNotice)

    static let types: Set<String> = ["changes.tree", "changes.file", "changes.page", "changes.line", "changes.review", "changes.replies", "changes.notice"]
    private enum Keys: String, CodingKey { case rows }

    init(type: String, from decoder: any Decoder) throws {
        switch type {
        case "changes.tree": self = .tree(try decoder.container(keyedBy: Keys.self).decode([ChangesTreeRow].self, forKey: .rows))
        case "changes.file": self = .file(try ChangesFileHeader(from: decoder))
        case "changes.page": self = .page(try ChangesPage(from: decoder))
        case "changes.line": self = .line(try ChangesWholeLine(from: decoder))
        case "changes.review": self = .review(try ChangesReview(from: decoder))
        case "changes.replies": self = .replies(try ChangesReplies(from: decoder))
        default: self = .notice(try ChangesNotice(from: decoder))
        }
    }
}
