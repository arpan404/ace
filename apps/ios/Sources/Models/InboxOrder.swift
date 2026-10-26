import Foundation

/// Moving threads by hand in the merged inbox: among Pinned, and in the Threads list when it is
/// sorted by hand. The phone shows one list across machines, so each machine in the group gets
/// the same move with the group as shown, works out the places with the shared rules
/// (`bridge/inbox-place.ts`) and records only its own threads'. Swift only routes.
extension MachineInbox {
    /// Whether rows in `section` can be moved by hand: Pinned always; Threads when sorted by hand.
    func movable(_ section: MergedInbox.Section) -> Bool {
        section.key == "pinned" || (section.key == "threads" && sortBy(in: "") == "manual")
    }

    /// Puts `key` at `index` among the other rows of `section` (as shown, top first).
    func move(_ key: InboxKey, in section: MergedInbox.Section, to index: Int) async {
        let pinned = section.key == "pinned"
        guard pinned || section.key == "threads", section.rows.contains(key) else { return }
        let shown: [[String: Any]] = section.rows.compactMap { other in
            guard let row = row(other) else { return nil }
            let order = pinned ? row.pinOrder : row.listOrder
            return ["machineId": other.machineId, "id": other.id, "order": order.map { $0 as Any } ?? NSNull()]
        }
        var machines: [String] = []
        for row in section.rows where !machines.contains(row.machineId) { machines.append(row.machineId) }
        let move: [String: Any] = ["kind": "move", "group": pinned ? "pinned" : "listed", "machineId": key.machineId,
                                   "threadId": key.id, "shown": shown, "to": max(0, index)]
        for machine in machines { _ = await client(machine)?.inboxCommand(move) }
    }
}
