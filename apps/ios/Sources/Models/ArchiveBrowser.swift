import Foundation
import Observation

/// `archive.list` from `bridge/archive.ts`: the archived threads in the shared order (most
/// recently archived first) and the SDK archive window's paging state. Rows arrive as inbox rows.
struct ArchiveList: Decodable, Sendable, Equatable {
    let open: Bool
    var ids: [String] = []
    var more = false
    var loaded = false
    var loading = false
    var failed = false
    private enum Keys: String, CodingKey { case open, ids, more, loaded, loading, failed }
    init(open: Bool, ids: [String] = [], more: Bool = false, loaded: Bool = false, loading: Bool = false, failed: Bool = false) {
        self.open = open; self.ids = ids; self.more = more; self.loaded = loaded; self.loading = loading; self.failed = failed
    }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        open = try box.decode(Bool.self, forKey: .open)
        ids = try box.decodeIfPresent([String].self, forKey: .ids) ?? []
        more = try box.decodeIfPresent(Bool.self, forKey: .more) ?? false
        loaded = try box.decodeIfPresent(Bool.self, forKey: .loaded) ?? false
        loading = try box.decodeIfPresent(Bool.self, forKey: .loading) ?? false
        failed = try box.decodeIfPresent(Bool.self, forKey: .failed) ?? false
    }
}

/// One machine's archive while the archive sheet shows it. Asking for the next page is guarded
/// here as well as in the bridge, so a fast scroll or a double tap asks for one page at a time.
@MainActor @Observable final class ArchiveBrowserModel {
    private(set) var list = ArchiveList(open: false)
    /// A page was asked for and its answer hasn't arrived yet.
    private(set) var requesting = false
    var loading: Bool { requesting || list.loading }
    var canLoadMore: Bool { list.open && list.loaded && list.more && !loading }

    func apply(_ next: ArchiveList) {
        // Every list the bridge sends after a request reflects it (loading, or the page landed);
        // the bridge refuses a second page while one is loading.
        requesting = false
        list = next
    }
    /// Claim the next page; false when one is already on its way or there is none.
    func beginPage() -> Bool {
        guard canLoadMore else { return false }
        requesting = true
        return true
    }
    func reset() { list = ArchiveList(open: false); requesting = false }
}

extension ClientModel {
    /// Follow this machine's archive window (`bridge/archive.ts`).
    func openArchive() { action(["type": "archive", "action": ["kind": "open"]]) }
    /// The next 20 archived threads; true when a page was asked for.
    @discardableResult func loadMoreArchived() -> Bool {
        guard archive.beginPage() else { return false }
        return action(["type": "archive", "action": ["kind": "more"]])
    }
    /// Back to the home window; the archived rows leave this runtime's store.
    func closeArchive() {
        archive.reset()
        action(["type": "archive", "action": ["kind": "close"]])
    }
}
