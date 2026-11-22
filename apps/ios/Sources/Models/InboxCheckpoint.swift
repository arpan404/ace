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
    /// The Spade tab's kept state (`spade.checkpoint`).
    nonisolated static let spadeSuffix = "-spade.json"

    /// Replaces the kept copy whole: a reader sees the old file or the new one, never a mix.
    nonisolated static func write(_ json: String, database: URL) throws {
        try write(json, to: url(database: database))
    }
    /// Replaces the kept Spade state whole, as `write` does the inbox.
    nonisolated static func writeSpade(_ json: String, database: URL) throws {
        try write(json, to: URL(fileURLWithPath: database.path + spadeSuffix))
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
        let inbox = patches(at: url(database: database)).filter {
            switch $0 {
            case .inboxReset, .inbox, .inboxSections, .chatSections: true
            default: false
            }
        }
        // Only Spade's state: never a conversation, which the runtime follows live.
        let spade = patches(at: URL(fileURLWithPath: database.path + spadeSuffix)).filter {
            if case .spade(.state) = $0 { true } else { false }
        }
        return inbox + spade
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
