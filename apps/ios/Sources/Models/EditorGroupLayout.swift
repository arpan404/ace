import Foundation

/// The iPad editor's groups: up to two side by side, each with its own tabs and the one it shows.
/// Every open file is a tab in exactly one group, and a group always holds at least one tab, so
/// closing or moving a group's last tab merges the groups back. Compact width shows `collapsed`:
/// one group with every tab, leaving the split stored for when the room comes back.
struct EditorGroupLayout: Codable, Equatable, Sendable {
    struct Group: Codable, Equatable, Sendable, Identifiable {
        let id: String
        var tabs: [String]
        var active: String
    }

    static let maxGroups = 2
    private static let ids = ["a", "b"]

    private(set) var groups: [Group] = []
    /// The group a file opens in, and the one whose file compact width shows.
    private(set) var focused: String?

    /// The file the focused group shows.
    var shown: String? { focusedIndex.map { groups[$0].active } }

    /// Compact width: one group, the focused one's id, with every tab in group order.
    var collapsed: EditorGroupLayout {
        guard let shown, let focused, groups.count > 1 else { return self }
        var tabs: [String] = []
        for path in groups.flatMap(\.tabs) where !tabs.contains(path) { tabs.append(path) }
        return EditorGroupLayout(groups: [Group(id: focused, tabs: tabs, active: shown)], focused: focused)
    }

    func group(of path: String) -> Group? { groups.first { $0.tabs.contains(path) } }

    /// The group that isn't `id`, when there are two.
    func other(than id: String) -> Group? { groups.first { $0.id != id } }

    /// Split right is there for a file whose group keeps another tab, while there's one group.
    func canSplit(_ path: String) -> Bool {
        groups.count == 1 && (group(of: path)?.tabs.count ?? 0) > 1
    }

    // MARK: Changes

    mutating func focus(_ id: String) {
        if groups.contains(where: { $0.id == id }) { focused = id }
    }

    /// Shows `path`: where it is open already, else as a new tab of the focused group.
    mutating func open(_ path: String) {
        if let at = index(of: path) {
            groups[at].active = path
            focused = groups[at].id
            return
        }
        guard let at = focusedIndex else {
            let id = Self.ids[0]
            groups = [Group(id: id, tabs: [path], active: path)]
            focused = id
            return
        }
        groups[at].tabs.append(path)
        groups[at].active = path
    }

    /// Shows `path` in the group beside the focused one, making it when there's room.
    mutating func openToSide(_ path: String) {
        guard let focused else { return open(path) }
        if let side = other(than: focused) {
            if side.tabs.contains(path) { open(path) } else { move(path, to: side.id) }
        } else if group(of: path) == nil {
            let id = newId()
            groups.append(Group(id: id, tabs: [path], active: path))
            self.focused = id
        } else {
            split(path)
        }
    }

    /// Split right: `path` moves into a new group beside its own, or into the other group when
    /// there are two already. A group's only tab stays where it is.
    mutating func split(_ path: String) {
        guard let from = index(of: path) else { return }
        if let side = other(than: groups[from].id) { return move(path, to: side.id) }
        guard groups[from].tabs.count > 1, groups.count < Self.maxGroups else { return }
        let id = newId()
        remove(path, from: from)
        groups.insert(Group(id: id, tabs: [path], active: path), at: from + 1)
        focused = id
    }

    /// Moves `path` to the end of group `id` and shows it there; an emptied group goes.
    mutating func move(_ path: String, to id: String) {
        guard let from = index(of: path), groups[from].id != id, groups.contains(where: { $0.id == id }) else { return }
        remove(path, from: from)
        guard let to = groups.firstIndex(where: { $0.id == id }) else { return }
        groups[to].tabs.append(path)
        groups[to].active = path
        focused = id
    }

    /// Closes `path`'s tab; the group shows the tab after it, else the one before.
    mutating func close(_ path: String) {
        guard let at = index(of: path) else { return }
        remove(path, from: at)
    }

    /// A rename or move on the computer: the tab follows the file, in its place.
    mutating func rename(_ path: String, to destination: String) {
        guard let at = index(of: path), let tab = groups[at].tabs.firstIndex(of: path) else { return }
        if index(of: destination) != nil { return close(path) }
        groups[at].tabs[tab] = destination
        if groups[at].active == path { groups[at].active = destination }
    }

    /// Follows the files the computer remembers open. Files closed since `previous` lose their
    /// tabs; on the first look (`previous` nil) every tab not open goes, except `keep`, the file
    /// being opened now. A file in `held` (unsaved changes) keeps its tab even when closed. Files
    /// open but not in a group join the focused group without showing.
    mutating func sync(open: [String], previous: [String]?, keep: String?, held: Set<String> = []) {
        let now = Set(open)
        let closed = previous.map { Set($0).subtracting(now) }
            ?? Set(groups.flatMap(\.tabs)).subtracting(now).subtracting(keep.map { [$0] } ?? [])
        for path in closed.subtracting(held) { close(path) }
        for path in open where index(of: path) == nil {
            if let at = focusedIndex { groups[at].tabs.append(path) } else { self.open(path) }
        }
    }

    // MARK: Storage

    /// The layout as stored for the next time this checkout's editor opens.
    var stored: String? {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// A stored layout; one that can't be read starts empty.
    static func restore(_ stored: String) -> EditorGroupLayout {
        (try? JSONDecoder().decode(EditorGroupLayout.self, from: Data(stored.utf8))) ?? EditorGroupLayout()
    }

    // MARK: Helpers

    private var focusedIndex: Int? { groups.firstIndex { $0.id == focused } }
    private func index(of path: String) -> Int? { groups.firstIndex { $0.tabs.contains(path) } }
    private func newId() -> String { Self.ids.first { id in !groups.contains { $0.id == id } } ?? "g\(groups.count)" }

    private mutating func remove(_ path: String, from at: Int) {
        guard let tab = groups[at].tabs.firstIndex(of: path) else { return }
        groups[at].tabs.remove(at: tab)
        if groups[at].tabs.isEmpty {
            let gone = groups.remove(at: at).id
            if focused == gone { focused = groups.first?.id }
        } else if groups[at].active == path {
            groups[at].active = groups[at].tabs[min(tab, groups[at].tabs.count - 1)]
        }
    }
}
