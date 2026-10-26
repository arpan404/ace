import Foundation
import Observation

/// One machine's inbox rows by thread id, observed row by row: a view that reads one row redraws
/// when that row changes, and only a view that reads which rows exist (the count, every value)
/// redraws when one joins or leaves. A row written again unchanged, as the bridge re-sends every
/// row when its connection or account list changes, redraws nothing.
@MainActor @Observable final class InboxRowStore {
    @MainActor @Observable final class Slot {
        /// Nil once the row has left, so a view still holding this slot reads it again.
        fileprivate(set) var row: ThreadRow?
        init(_ row: ThreadRow) { self.row = row }
    }
    @ObservationIgnored private var slots: [String: Slot] = [:]
    /// Changes whenever a row joins or leaves.
    private var membership = 0

    subscript(id: String) -> ThreadRow? {
        get {
            if let slot = slots[id] { return slot.row }
            _ = membership // A missing row is read again when one joins.
            return nil
        }
        set {
            if let newValue {
                if let slot = slots[id] {
                    if slot.row != newValue { slot.row = newValue }
                } else {
                    slots[id] = Slot(newValue)
                    membership &+= 1
                }
            } else if let slot = slots.removeValue(forKey: id) {
                slot.row = nil
                membership &+= 1
            }
        }
    }
    var count: Int { _ = membership; return slots.count }
    var isEmpty: Bool { count == 0 }
    var ids: [String] { _ = membership; return Array(slots.keys) }
    /// Every row, read row by row: a view reading this redraws when any row changes.
    var values: [ThreadRow] { ids.compactMap { self[$0] } }
    func removeAll() {
        guard !slots.isEmpty else { return }
        for slot in slots.values { slot.row = nil }
        slots.removeAll(keepingCapacity: true)
        membership &+= 1
    }
}
