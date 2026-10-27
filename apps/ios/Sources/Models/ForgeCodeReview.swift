import Foundation

/// What Files changed shows instead of All commits: one commit, or what changed after `since`
/// through `commit` (`bridge/forge-commits.ts`).
struct ForgeRange: Hashable, Sendable {
    let commit: String
    var since: String?
    var json: [String: Any] {
        var value: [String: Any] = ["commit": commit]
        if let since { value["since"] = since }
        return value
    }
}

/// A pull request's commits, oldest first (`forge.pull.commits`).
struct ForgeCommits: Decodable, Sendable, Equatable {
    struct Commit: Decodable, Sendable, Equatable, Hashable, Identifiable {
        let sha: String
        let short: String
        let title: String
        let author: String
        let at: Double?
        let additions: Int?
        let deletions: Int?
        var id: String { sha }
    }
    /// The commits pushed after the signed-in reviewer's latest review.
    struct SinceReview: Decodable, Sendable, Equatable, Hashable { let since: String; let commit: String; let count: Int }
    let headSha: String
    let commits: [Commit]
    let truncated: Bool
    var sinceReview: SinceReview?
}

/// A changed file read whole on both sides (`forge.pull.file.sides`): its Markdown drawn as it
/// reads, each block kept, removed or added; or its two images.
enum ForgeFileSides: Decodable, Sendable, Equatable {
    struct Block: Decodable, Sendable, Equatable {
        /// `same`, `del` or `add`.
        let kind: String
        let blocks: [ForgeRichBlock]
    }
    /// One side of an image: bytes (base64), none (added or removed), or why it can't be drawn.
    struct Image: Decodable, Sendable, Equatable {
        let state: String
        let mimeType: String?
        let data: String?
        let size: Int?
        let reason: String?
    }
    case rendered(blocks: [Block], hidden: Int)
    case image(before: Image, after: Image)

    private enum Keys: String, CodingKey { case `as`, blocks, hidden, before, after }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if try c.decode(String.self, forKey: .as) == "image" {
            self = .image(before: try c.decode(Image.self, forKey: .before), after: try c.decode(Image.self, forKey: .after))
        } else {
            self = .rendered(blocks: try c.decode([Block].self, forKey: .blocks), hidden: try c.decode(Int.self, forKey: .hidden))
        }
    }
}

/// The exact commits a file's diff is between (`revisions` on `forge.pull.file`). Content at a
/// commit never changes, so its rendered and image views read these and draw that version.
struct ForgeFileRevisions: Decodable, Sendable, Hashable {
    let base: String
    let head: String
    /// The pull request's head when the diff was read: where a Viewed mark is set.
    let prHead: String
    let path: String
    let previousPath: String?
    let status: String
    var json: [String: Any] {
        ["base": base, "head": head, "prHead": prHead, "path": path, "previousPath": previousPath ?? NSNull(), "status": status]
    }
}

/// Which pull request head a Viewed mark may name for what is on screen. The patch is always the
/// version the page read; a rendered or image view only once it has drawn the same commits. Nil
/// while it still shows another version (after a push, before it reads again): no mark then.
enum ForgeViewedVersion {
    static func head(patchHead: String, current: ForgeFileRevisions?, drawsSides: Bool, shown: ForgeFileRevisions?) -> String? {
        guard drawsSides else { return patchHead }
        guard let current, shown == current else { return nil }
        return current.prHead
    }
}

/// Both sides of a file and the commits they were read at.
struct ForgeFileSidesRead: Decodable, Sendable, Equatable {
    let sides: ForgeFileSides
    let revisions: ForgeFileRevisions?
    private enum Keys: String, CodingKey { case revisions }
    init(from decoder: Decoder) throws {
        sides = try ForgeFileSides(from: decoder)
        revisions = try decoder.container(keyedBy: Keys.self).decodeIfPresent(ForgeFileRevisions.self, forKey: .revisions)
    }
}

extension ClientModel {
    static func forgeCommitsRead(project: String, number: Int, repository: ForgeRepository? = nil) -> [String: Any] {
        on(repository, ["type": "forge.pull.commits", "project": project, "number": number])
    }
    func forgeCommits(project: String, number: Int, repository: ForgeRepository? = nil) async throws -> ForgeCommits {
        try await read(Self.forgeCommitsRead(project: project, number: number, repository: repository), as: ForgeCommits.self)
    }
    /// Both sides of one file, `as` `rendered` or `image`. Never kept: content at a commit is
    /// read once per view and images can be large.
    /// Pinned to `revisions` when given, so what is drawn is the version the page's diff shows.
    func forgeFileSides(_ route: ForgeRoute, as kind: String, revisions: ForgeFileRevisions?) async throws -> ForgeFileSidesRead {
        var request: [String: Any] = ["type": "forge.pull.file.sides", "project": route.project, "number": route.number,
                                      "path": route.path ?? "", "as": kind]
        if let index = route.index { request["index"] = index }
        if let range = route.range { request["range"] = range.json }
        if let revisions { request["revisions"] = revisions.json }
        return try await service(Self.on(route.repository, request), as: ForgeFileSidesRead.self, timeout: .seconds(45))
    }
}
