import Foundation
import Observation
import Testing
@testable import Ace

/// What redraws when the inbox changes: a view reading one row redraws for that row alone.
@Suite @MainActor struct InboxRowStoreTests {
    @Test func aRowReaderRedrawsForItsOwnRowOnlyAndNeverForAnUnchangedCopy() {
        let rows = InboxRowStore()
        rows["a"] = row("a", label: "Working")
        rows["b"] = row("b", label: "Working")

        #expect(!redraws(reading: { _ = rows["a"] }, after: { rows["b"] = row("b", label: "Done") }))
        #expect(!redraws(reading: { _ = rows["a"] }, after: { rows["a"] = row("a", label: "Working") }))
        #expect(redraws(reading: { _ = rows["a"] }, after: { rows["a"] = row("a", label: "Done") }))
        #expect(redraws(reading: { _ = rows["a"] }, after: { rows["a"] = nil }))
        #expect(rows["a"] == nil)
    }

    @Test func aMissingRowAndTheWholeListRedrawWhenARowJoins() {
        let rows = InboxRowStore()
        rows["a"] = row("a", label: "Working")
        #expect(redraws(reading: { _ = rows["late"] }, after: { rows["late"] = row("late", label: "Done") }))
        #expect(redraws(reading: { _ = rows.count }, after: { rows["new"] = row("new", label: "Done") }))
        #expect(!redraws(reading: { _ = rows.count }, after: { rows["a"] = row("a", label: "Done") }))
        #expect(redraws(reading: { _ = rows.values }, after: { rows["a"] = row("a", label: "Working") }))
        #expect(Set(rows.ids) == ["a", "late", "new"])
    }

    @Test func clearingTellsEveryReaderAndEmptiesTheList() {
        let rows = InboxRowStore()
        rows["a"] = row("a", label: "Working")
        #expect(redraws(reading: { _ = rows["a"] }, after: { rows.removeAll() }))
        #expect(rows.isEmpty)
    }

    private func redraws(reading: () -> Void, after change: () -> Void) -> Bool {
        let fired = Flag()
        withObservationTracking(reading, onChange: { fired.set() })
        change()
        return fired.value
    }
    private func row(_ id: String, label: String) -> ThreadRow {
        ThreadRow(id: id, title: id, state: "working", attention: nil, project: "ace", branch: "", machine: "", provider: "codex",
                  model: "", agents: 1, snoozedUntil: nil, updatedAt: 1, canSteer: false,
                  status: StatusDisplay(label: label, token: "working"), machineId: nil, activityAt: nil)
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func set() { lock.withLock { fired = true } }
    var value: Bool { lock.withLock { fired } }
}
