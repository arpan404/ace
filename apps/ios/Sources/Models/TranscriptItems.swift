import Observation

/// Rows observe their own item lookup. A page can change membership without invalidating
/// the overlapping rows, and a block waiting for an item wakes when that item lands.
@MainActor @Observable final class TranscriptItems<Row: AnyObject> {
    @ObservationIgnored private var rows: [String: Row] = [:]

    subscript(id: String) -> Row? {
        get {
            access(keyPath: \.[id])
            return rows[id]
        }
        set {
            guard rows[id] !== newValue else { return }
            withMutation(keyPath: \.entries) {
                withMutation(keyPath: \.[id]) { rows[id] = newValue }
            }
        }
    }

    var entries: [String: Row] {
        access(keyPath: \.entries)
        return rows
    }
    var count: Int { entries.count }
    var isEmpty: Bool { entries.isEmpty }
    var values: Dictionary<String, Row>.Values { entries.values }

    func removeAll() {
        for id in rows.keys { self[id] = nil }
    }

    func replace(with incoming: TranscriptItems<Row>) {
        for id in rows.keys where incoming.rows[id] == nil { self[id] = nil }
        for (id, row) in incoming.rows { self[id] = row }
    }
}
