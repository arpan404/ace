import Foundation

/// Moving threads by hand in the merged inbox: among Pinned, and in the Threads list when it is
/// sorted by hand. The phone shows one list across machines, so each machine in the group gets
/// the same move with the group as shown, works out the places with the shared rules
/// (`bridge/inbox-place.ts`) and records only its own threads'. Swift only routes.
extension MachineInbox {
    /// Whether rows in `section` can be moved by hand: every machine with rows there can act, and
    /// for Threads every one of them sorts by hand. A move needs each machine to record its part.
    func movable(_ section: MergedInbox.Section) -> Bool {
        guard section.key == "pinned" || section.key == "threads" else { return false }
        return machines(in: section).allSatisfy { id in
            guard let client = client(id), client.canOperate else { return false }
            return section.key == "pinned" || client.inboxLayout.sortBy == "manual"
        }
    }

    /// Puts `key` at `index` among the other rows of `section` (as shown, top first). The moving
    /// row's machine gets it first, the rest at the same time; a machine that can't record its
    /// part says so.
    func move(_ key: InboxKey, in section: MergedInbox.Section, to index: Int) async {
        let pinned = section.key == "pinned"
        guard movable(section), section.rows.contains(key) else { return }
        // Every row shown, so `index` counts the same rows; one not loaded yet has no place.
        let shown: [Shown] = section.rows.map { other in
            let row = row(other)
            return Shown(machineId: other.machineId, id: other.id, order: pinned ? row?.pinOrder : row?.listOrder)
        }
        let machines = [key.machineId] + machines(in: section).filter { $0 != key.machineId }
        let failed = await withTaskGroup(of: String?.self) { group in
            for machine in machines {
                guard let client = client(machine) else { continue }
                group.addTask {
                    await client.inboxCommand(Self.moveAction(key, pinned: pinned, shown: shown, to: index)) ? nil : machine
                }
            }
            var failed: [String] = []
            for await machine in group { if let machine { failed.append(machine) } }
            return failed
        }
        for machine in failed {
            client(machine)?.error = "Couldn't save the new order on \(name(machine))."
        }
    }

    private struct Shown: Sendable { let machineId: String; let id: String; let order: Double? }

    /// The bridge's move (`PlaceAction`), built per machine so each send owns its copy.
    private nonisolated static func moveAction(_ key: InboxKey, pinned: Bool, shown: [Shown], to index: Int) -> [String: Any] {
        ["kind": "move", "group": pinned ? "pinned" : "listed", "machineId": key.machineId, "threadId": key.id,
         "shown": shown.map { ["machineId": $0.machineId, "id": $0.id, "order": $0.order.map { $0 as Any } ?? NSNull()] },
         "to": max(0, index)]
    }

    /// The machines with rows in `section`, in order of first appearance.
    private func machines(in section: MergedInbox.Section) -> [String] {
        var machines: [String] = []
        for row in section.rows where !machines.contains(row.machineId) { machines.append(row.machineId) }
        return machines
    }
}
