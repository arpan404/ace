import Foundation

/// A comment as `bridge/forge-conversation.ts` sends it: its text, reactions and what this
/// account may do to it, all decided by the bridge.
struct ForgeComment: Decodable, Sendable, Equatable, Identifiable {
    struct Reaction: Decodable, Sendable, Equatable, Hashable { let content: String; let label: String; let count: Int; let viewer: Bool }
    let id: String
    let commentId: Int
    /// `issue`, `inline` or `review`.
    let source: String
    let author: String
    let at: Double?
    let body: String
    let blocks: [ForgeRichBlock]
    let hidden: String?
    let reactions: [Reaction]
    let url: String
    let quote: Bool
    let quoteText: String
    let edit: Bool
    let remove: Bool
    let hide: Bool
    let unhide: Bool
    let editBody: String
    let tasks: Bool
}

/// A line conversation: where it sits, whether it is resolved, its comments and its reply box.
struct ForgeLineThread: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let place: String
    let path: String
    let line: Int?
    let side: String
    let resolved: Bool
    let outdated: Bool
    let canResolve: Bool
    let canReply: Bool
    let replyOff: String?
    let comments: [ForgeComment]
}

/// One row of a pull request's Timeline (`bridge/forge-timeline.ts`).
enum ForgeTimelineRow: Decodable, Sendable, Equatable, Identifiable {
    case comment(id: String, comment: ForgeComment)
    case review(id: String, comment: ForgeComment, words: String, tone: String?, stale: Bool)
    case thread(id: String, thread: ForgeLineThread)
    case event(id: String, actor: String, text: String, tone: String?, at: Double?)
    case commit(id: String, sha: String, title: String, author: String, at: Double?)
    case references(id: String, lines: [Reference])
    case unknown(id: String)

    struct Reference: Decodable, Sendable, Equatable, Hashable { let actor: String; let text: String }
    private enum Keys: String, CodingKey { case kind, id, comment, words, tone, stale, thread, actor, text, at, sha, title, author, lines }

    var id: String {
        switch self {
        case .comment(let id, _), .review(let id, _, _, _, _), .thread(let id, _), .event(let id, _, _, _, _),
             .commit(let id, _, _, _, _), .references(let id, _), .unknown(let id): id
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let id = try c.decode(String.self, forKey: .id)
        switch try c.decode(String.self, forKey: .kind) {
        case "comment": self = .comment(id: id, comment: try c.decode(ForgeComment.self, forKey: .comment))
        case "review":
            self = .review(id: id, comment: try c.decode(ForgeComment.self, forKey: .comment), words: try c.decode(String.self, forKey: .words),
                           tone: try c.decodeIfPresent(String.self, forKey: .tone), stale: try c.decode(Bool.self, forKey: .stale))
        case "thread": self = .thread(id: id, thread: try c.decode(ForgeLineThread.self, forKey: .thread))
        case "event":
            self = .event(id: id, actor: try c.decode(String.self, forKey: .actor), text: try c.decode(String.self, forKey: .text),
                          tone: try c.decodeIfPresent(String.self, forKey: .tone), at: try c.decodeIfPresent(Double.self, forKey: .at))
        case "commit":
            self = .commit(id: id, sha: try c.decode(String.self, forKey: .sha), title: try c.decode(String.self, forKey: .title),
                           author: try c.decode(String.self, forKey: .author), at: try c.decodeIfPresent(Double.self, forKey: .at))
        case "references": self = .references(id: id, lines: try c.decode([Reference].self, forKey: .lines))
        // A row kind a newer bridge adds is skipped, never fatal.
        default: self = .unknown(id: id)
        }
    }
}

/// The Review sheet: pending line comments, the three verdicts and why any are off.
struct ForgeReviewSheet: Decodable, Sendable, Equatable {
    struct Draft: Decodable, Sendable, Equatable, Identifiable { let id: String; let place: String; let body: String; let outdated: Bool }
    struct Verdict: Decodable, Sendable, Equatable, Hashable { let event: String; let label: String; let off: Bool }
    let drafts: [Draft]
    let verdicts: [Verdict]
    let blocked: String?
    let refused: String?
    let stale: String?
    let headSha: String
}

/// A box that shows; `off` says why it can't be used now.
struct ForgeBox: Decodable, Sendable, Equatable { let off: String? }

struct ForgeTimeline: Decodable, Sendable, Equatable {
    let number: Int
    let repository: ForgeRepository
    let title: String
    let url: String
    let rows: [ForgeTimelineRow]
    let partial: Bool
    let box: ForgeBox?
    let review: ForgeReviewSheet?
    let uncertain: [String]
    let unread: String?
}

/// One changed file in the Code view (`bridge/forge-code.ts`).
struct ForgeFileDiff: Decodable, Sendable, Equatable {
    /// The commits this diff is between; a copy kept from before they were sent has none.
    var revisions: ForgeFileRevisions?
    struct Anchor: Decodable, Sendable, Equatable, Hashable { let line: Int; let side: String }
    struct Draft: Decodable, Sendable, Equatable, Hashable, Identifiable { let id: String; let body: String }
    struct Line: Decodable, Sendable, Equatable {
        /// `add`, `del`, `context` or `hunk`.
        let kind: String
        let old: Int?
        let new: Int?
        let text: String
        let clipped: Bool
        let anchor: Anchor?
        /// Which change of the patch it is in: a span of lines on one side of one change is a
        /// range GitHub takes a comment on.
        let hunk: Int
        let threads: [ForgeLineThread]
        let drafts: [Draft]
    }
    let number: Int
    let repository: ForgeRepository
    let path: String
    let previousPath: String?
    let status: String
    let additions: Int
    let deletions: Int
    let lines: [Line]
    let hiddenLines: Int
    let truncated: Bool
    let empty: Bool
    let outside: [ForgeLineThread]
    let commenting: ForgeBox?
    let pending: Int
    let headSha: String
    /// `patch`, `image` (both versions drawn), `content` or `large` (both sides read whole).
    let show: String
    /// A Markdown file that can also be drawn as it reads.
    let rendered: Bool
    /// Side by side: each row's line index on the left and on the right.
    let pairs: [[Int?]]
    /// `viewed`, `changed` (pushed to since) or `unviewed`; nil where the range has no marks.
    let viewed: String?
}

/// What a review write did: done, refused with why, or unconfirmed (to reconcile, never resend).
struct ForgeReviewOutcome: Decodable, Sendable, Equatable {
    let ok: Bool
    let message: String
    let uncertain: Bool
}

/// Which pull request a review write is on.
struct ForgePullTarget: Sendable, Equatable {
    let project: String
    let number: Int
    let repository: ForgeRepository
}

extension ClientModel {
    static func forgeTimelineRead(project: String, number: Int, repository: ForgeRepository? = nil) -> [String: Any] {
        on(repository, ["type": "forge.pull.timeline", "project": project, "number": number])
    }
    static func forgeFileRead(project: String, number: Int, repository: ForgeRepository? = nil, path: String, index: Int?, range: ForgeRange? = nil) -> [String: Any] {
        var read: [String: Any] = ["type": "forge.pull.file", "project": project, "number": number, "path": path]
        if let index { read["index"] = index }
        if let range { read["range"] = range.json }
        return on(repository, read)
    }
    func forgeTimeline(project: String, number: Int, repository: ForgeRepository? = nil) async throws -> ForgeTimeline {
        try await read(Self.forgeTimelineRead(project: project, number: number, repository: repository), as: ForgeTimeline.self)
    }
    func forgeFile(project: String, number: Int, repository: ForgeRepository? = nil, path: String, index: Int?, range: ForgeRange? = nil) async throws -> ForgeFileDiff {
        try await read(Self.forgeFileRead(project: project, number: number, repository: repository, path: path, index: index, range: range), as: ForgeFileDiff.self)
    }
    /// One review write, sent once. A view-only phone never sends it.
    func forgeReview(_ target: ForgePullTarget, _ action: [String: Any]) async -> ForgeReviewOutcome {
        guard canOperate else {
            return ForgeReviewOutcome(ok: false, message: "View only. Comment on your computer, or pair this phone with View and act.", uncertain: false)
        }
        let request: [String: Any] = ["type": "forge.review", "project": target.project, "number": target.number,
                                      "repository": target.repository.json, "action": action]
        do { return try await service(request, as: ForgeReviewOutcome.self) }
        catch { return ForgeReviewOutcome(ok: false, message: error.localizedDescription, uncertain: false) }
    }
}

/// A pull request's changed files (`forge.pull.files`) for All commits or a range, each with its
/// open conversations and its Viewed mark.
struct ForgeFilesList: Decodable, Sendable, Equatable {
    struct File: Decodable, Sendable, Equatable, Hashable {
        let path: String
        let status: String
        let additions: Int
        let deletions: Int
        let conversations: Int
        /// `viewed`, `changed` or `unviewed`; nil where the range shown has no marks.
        let viewed: String?
    }
    struct Range: Decodable, Sendable, Equatable { let commit: String; let since: String?; let label: String }
    let headSha: String
    let range: Range?
    let files: [File]
    let viewedCount: Int?
    let caveats: [String]
    let more: Bool
}

/// `@` and `#` suggestions for the caret (`forge.complete`), each with the edit a pick makes in
/// UTF-16 offsets.
struct ForgeCompletions: Decodable, Sendable, Equatable {
    struct Item: Decodable, Sendable, Equatable, Hashable { let label: String; let detail: String; let from: Int; let to: Int; let insert: String; let caret: Int }
    let items: [Item]
}

/// A pull request's reviewers (`forge.pull.reviewers`) and what this account may ask of each.
struct ForgeReviewers: Decodable, Sendable, Equatable {
    struct Row: Decodable, Sendable, Equatable, Hashable, Identifiable {
        let key: String
        let kind: String
        let name: String
        let label: String
        let words: String
        let tone: String?
        let reviewId: Int?
        let canRerequest: Bool
        let canRemove: Bool
        let canDismiss: Bool
        var id: String { key }
    }
    struct Person: Decodable, Sendable, Equatable, Hashable { let login: String; let name: String? }
    let rows: [Row]
    let suggested: [Person]
    let canRequest: Bool
}

/// Where an editor writes, so `@` and `#` search that repository with its pull request's or
/// issue's people first.
struct ForgeCompleter {
    let client: ClientModel
    let project: String
    let repository: ForgeRepository?
    /// `pull` or `issue`, and its number.
    let on: (kind: String, number: Int)?

    func suggestions(text: String, start: Int, end: Int) async -> [ForgeCompletions.Item] {
        var request: [String: Any] = ["type": "forge.complete", "project": project, "text": text, "start": start, "end": end]
        if let repository { request["repository"] = repository.json }
        if let on { request["on"] = ["kind": on.kind, "number": on.number] }
        return (try? await client.service(request, as: ForgeCompletions.self).items) ?? []
    }
}

extension ClientModel {
    static func forgeFilesRead(project: String, number: Int, repository: ForgeRepository? = nil, range: ForgeRange? = nil) -> [String: Any] {
        var read: [String: Any] = ["type": "forge.pull.files", "project": project, "number": number]
        if let range { read["range"] = range.json }
        return on(repository, read)
    }
    static func forgeReviewersRead(project: String, number: Int, repository: ForgeRepository? = nil) -> [String: Any] {
        on(repository, ["type": "forge.pull.reviewers", "project": project, "number": number])
    }
    func forgeFiles(project: String, number: Int, repository: ForgeRepository? = nil, range: ForgeRange? = nil) async throws -> ForgeFilesList {
        try await read(Self.forgeFilesRead(project: project, number: number, repository: repository, range: range), as: ForgeFilesList.self)
    }
    func forgeReviewers(project: String, number: Int, repository: ForgeRepository? = nil) async throws -> ForgeReviewers {
        try await read(Self.forgeReviewersRead(project: project, number: number, repository: repository), as: ForgeReviewers.self)
    }
}
