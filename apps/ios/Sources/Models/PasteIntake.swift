/// Long pastes on their way to a message, from the moment they are pasted until they are on it.
/// Each belongs to the thread it was pasted in (`scope`). In each thread they attach in the order
/// they were pasted, however their writes finish. One that finishes after its thread closed is
/// discarded, never attached to whichever thread is open by then. While any is still being
/// staged, Send waits. Pure: the caller stages, attaches and discards.
struct PasteIntake: Equatable {
    struct Adding: Equatable, Identifiable {
        let id: Int
        let scope: String
        let name: String
        /// Staged, waiting for an earlier paste; nil while it is still being written.
        var file: StagedAttachment?
        var failed = false
    }
    /// What a finished paste lets happen, in order.
    struct Release: Equatable {
        var attach: [StagedAttachment] = []
        var discard: [StagedAttachment] = []
    }
    private(set) var queue: [Adding] = []
    private var next = 1

    /// A paste began in `scope`: it holds Send there and shows as being added. Returns its ticket.
    mutating func began(scope: String, name: String) -> Int {
        defer { next += 1 }
        queue.append(Adding(id: next, scope: scope, name: name))
        return next
    }

    /// The paste `ticket` was written (`file`) or couldn't be (nil), with `open` the thread now open.
    mutating func finished(_ ticket: Int, file: StagedAttachment?, open: String?) -> Release {
        guard let index = queue.firstIndex(where: { $0.id == ticket }) else {
            return Release(discard: file.map { [$0] } ?? [])
        }
        if let file { queue[index].file = file } else { queue[index].failed = true }
        let scope = queue[index].scope
        var release = Release()
        // Its thread closed: everything it still holds there goes.
        if scope != open {
            release.discard = queue.filter { $0.scope == scope }.compactMap(\.file)
            queue.removeAll { $0.scope == scope && ($0.file != nil || $0.failed) }
            return release
        }
        // In paste order: the front of this thread's line goes while it is done.
        while let front = queue.firstIndex(where: { $0.scope == scope }), queue[front].file != nil || queue[front].failed {
            if let staged = queue[front].file { release.attach.append(staged) }
            queue.remove(at: front)
        }
        return release
    }

    /// Whether a paste in `scope` is still on its way, so Send waits.
    func holdsSend(in scope: String?) -> Bool { queue.contains { $0.scope == scope } }
    /// The pastes being added in `scope`, in paste order, for their placeholder chips.
    func adding(in scope: String?) -> [Adding] { queue.filter { $0.scope == scope } }
}
