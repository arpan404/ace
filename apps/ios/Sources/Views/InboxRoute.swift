import Foundation

/// A page on one of the inbox's navigation stacks: a thread on its machine, or a pull request or
/// issue page on the Pulls tab. Thread pages keep their machine while they slide away.
enum InboxRoute: Hashable {
    case thread(InboxKey)
    case forge(ForgeRoute)

    /// The thread this page shows; nil for a pull request or issue page.
    var thread: InboxKey? {
        if case .thread(let key) = self { return key }
        return nil
    }

    /// The threads a stack holds, in order; its pull request and issue pages are not threads.
    static func threads(_ path: [InboxRoute]) -> [InboxKey] { path.compactMap(\.thread) }
}

extension InboxKey {
    /// The key as scene storage keeps it: machine and thread id, which never hold a newline.
    var place: String { machineId + "\n" + id }
    init?(place: String) {
        let parts = place.split(separator: "\n", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        self.init(machineId: String(parts[0]), id: String(parts[1]))
    }
}
