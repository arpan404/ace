import Foundation

/// The inbox a machine's bridge kept for the next launch (`bridge/inbox-checkpoint.ts`): the same
/// patches the live inbox sends, every row already in its unconfirmed form. The app replays it
/// before that machine's runtime starts, so the first frame shows the last known inbox; the
/// bridge replaces it in place once its own list is ready. It sits beside the machine's database
/// and is removed with it.
enum InboxCheckpoint {
    /// Larger files are ignored rather than read on the way to the first frame.
    nonisolated static let limit = 4 * 1024 * 1024

    nonisolated static func url(database: URL) -> URL { URL(fileURLWithPath: database.path + suffix) }
    nonisolated static let suffix = "-inbox.json"

    /// Replaces the kept copy whole: a reader sees the old file or the new one, never a mix.
    nonisolated static func write(_ json: String, database: URL) throws {
        let data = Data(json.utf8)
        guard data.count <= limit else { throw HostError.storage }
        try data.write(to: url(database: database), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// The kept patches, or none when there is no copy or it cannot be read.
    nonisolated static func read(database: URL) -> [BridgePatch] {
        let file = url(database: database)
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= limit,
              let data = try? Data(contentsOf: file),
              let patches = try? JSONDecoder().decode([BridgePatch].self, from: data) else { return [] }
        // Only inbox patches: a copy can never restore a connection state or a thread.
        return patches.filter {
            switch $0 {
            case .inboxReset, .inbox, .inboxSections: true
            default: false
            }
        }
    }
}
