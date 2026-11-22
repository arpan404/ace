import Foundation

/// The inbox a machine's bridge kept for the next launch (`bridge/inbox-checkpoint.ts`): the same
/// patches the live inbox sends, every row already in its unconfirmed form. The app replays it
/// before that machine's runtime starts, so the first frame shows the last known inbox; the
/// bridge replaces it in place once its own list is ready. Beside it, the Spade tab as last known
/// (`bridge/spade-checkpoint.ts`), so the tab is there in the first frame too. Both sit beside the
/// machine's database and are removed with it.
enum InboxCheckpoint {
    /// Larger files are ignored rather than read on the way to the first frame.
    nonisolated static let limit = 4 * 1024 * 1024

    nonisolated static func url(database: URL) -> URL { URL(fileURLWithPath: database.path + suffix) }
    nonisolated static let suffix = "-inbox.json"
    /// The Spade tab's kept state (`spade.checkpoint`), one file per principal (`KeptScope`).
    nonisolated static let spadePrefix = "-spade"
    nonisolated static func spadeURL(database: URL, scope: String) -> URL {
        URL(fileURLWithPath: database.path + spadePrefix + "-" + scope + ".json")
    }

    /// Replaces the kept copy whole: a reader sees the old file or the new one, never a mix.
    nonisolated static func write(_ json: String, database: URL) throws {
        try write(json, to: url(database: database))
    }
    /// Replaces the kept Spade state of `scope` whole, as `write` does the inbox.
    nonisolated static func writeSpade(_ json: String, database: URL, scope: String) throws {
        try write(json, to: spadeURL(database: database, scope: scope))
    }
    private nonisolated static func write(_ json: String, to file: URL) throws {
        let data = Data(json.utf8)
        guard data.count <= limit else { throw HostError.storage }
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Reads a machine's kept patches for `ClientModel.connect`, given its database.
    typealias Reader = @Sendable (URL) async -> [BridgePatch]
    /// `read` on a background task: the copy may be megabytes, kept off the main thread.
    nonisolated static let background: Reader = { database in
        await Task.detached(priority: .userInitiated) { read(database: database) }.value
    }

    /// The kept patches, or none when there is no copy or it cannot be read.
    nonisolated static func read(database: URL) -> [BridgePatch] {
        // Only inbox patches: a copy can never restore a connection state or a thread.
        patches(at: url(database: database)).filter {
            switch $0 {
            case .inboxReset, .inbox, .inboxSections, .chatSections: true
            default: false
            }
        }
    }

    /// Reads a machine's kept Spade state for whoever a connection signs in as (`KeptScope`).
    typealias SpadeReader = @Sendable (URL, String?) async -> [BridgePatch]
    nonisolated static let spadeBackground: SpadeReader = { database, scope in
        await Task.detached(priority: .userInitiated) { readSpade(database: database, scope: scope) }.value
    }

    /// The Spade tab as `scope` last kept it: only its state, never a conversation, which the
    /// runtime follows live. Every other principal's copy is removed on the way, so one account's
    /// never shows for another's.
    nonisolated static func readSpade(database: URL, scope: String?) -> [BridgePatch] {
        removeSpade(database: database, keeping: scope)
        guard let scope else { return [] }
        return patches(at: spadeURL(database: database, scope: scope)).filter {
            if case .spade(.state) = $0 { true } else { false }
        }
    }

    /// Removes the machine's kept Spade state: every principal's but `scope`'s, or all of it.
    nonisolated static func removeSpade(database: URL, keeping scope: String? = nil) {
        let directory = database.deletingLastPathComponent()
        let prefix = database.lastPathComponent + spadePrefix
        let kept = scope.map { spadeURL(database: database, scope: $0).lastPathComponent }
        for name in (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        where name.hasPrefix(prefix) && name != kept {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    private nonisolated static func patches(at file: URL) -> [BridgePatch] {
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= limit,
              let data = try? Data(contentsOf: file),
              let kept = try? JSONDecoder().decode([Kept].self, from: data) else { return [] }
        return kept.compactMap(\.patch)
    }

    /// One kept patch, or nil when this build can't read its shape (an older or newer build
    /// wrote it): that patch is left out, never the whole copy.
    private struct Kept: Decodable {
        let patch: BridgePatch?
        init(from decoder: any Decoder) throws { patch = try? BridgePatch(from: decoder) }
    }
}
