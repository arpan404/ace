import Foundation
import Observation
import Testing
@testable import Ace

@MainActor @Suite struct TranscriptItemsTests {
    private final class Row {}
    private final class Invalidations: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func increment() { lock.withLock { value += 1 } }
        var count: Int { lock.withLock { value } }
    }

    @Test func aPageJoinOnlyInvalidatesReadersOfEvictedItems() {
        for visited in [800, 8_000] {
            let items = TranscriptItems<Row>()
            let ids = (0..<visited).map(String.init)
            for index in 0..<400 { items[ids[index]] = Row() }
            var retainedInvalidations = 0
            var evictionInvalidations = 0
            var samples: [Duration] = []
            for offset in stride(from: 0, to: visited - 400, by: 200) {
                let kept = Invalidations()
                let evicted = Invalidations()
                // Simulate observed rows on both sides of the eviction boundary.
                for index in offset..<(offset + 24) {
                    withObservationTracking { _ = items[ids[index]] } onChange: { evicted.increment() }
                }
                for index in (offset + 200)..<(offset + 224) {
                    withObservationTracking { _ = items[ids[index]] } onChange: { kept.increment() }
                }
                samples.append(ContinuousClock().measure {
                    for index in offset..<(offset + 200) {
                        items[ids[index]] = nil
                        items[ids[index + 400]] = Row()
                    }
                })
                retainedInvalidations += kept.count
                evictionInvalidations += evicted.count
            }
            print("Joins through \(visited) items: \(retainedInvalidations) overlap invalidations, \(evictionInvalidations) eviction invalidations, median \(samples.sorted()[samples.count / 2])")
            #expect(retainedInvalidations == 0)
            #expect(evictionInvalidations == 24 * samples.count)
        }
    }

    @Test func aReplacementKeepsOverlapAndPublishesRemovedAndAddedItems() {
        let items = TranscriptItems<Row>()
        let overlap = Row()
        items["keep"] = overlap
        items["remove"] = Row()
        let replacement = TranscriptItems<Row>()
        let added = Row()
        replacement["keep"] = overlap
        replacement["add"] = added

        let overlapChanges = Invalidations()
        let membershipChanges = Invalidations()
        withObservationTracking { _ = items["keep"] } onChange: { overlapChanges.increment() }
        withObservationTracking { _ = items["remove"] } onChange: { membershipChanges.increment() }
        withObservationTracking { _ = items["add"] } onChange: { membershipChanges.increment() }
        items.replace(with: replacement)
        #expect(overlapChanges.count == 0)
        #expect(membershipChanges.count == 2)
        #expect(items["keep"] === overlap)
        #expect(items["add"] === added)
        #expect(items["remove"] == nil)
    }

    @Test func anItemThatArrivesAfterItsBlockWakesTheWaitingRow() {
        let items = TranscriptItems<Row>()
        let changes = Invalidations()
        withObservationTracking { _ = items["late"] } onChange: { changes.increment() }
        items["unrelated"] = Row()
        #expect(changes.count == 0)
        let row = Row()
        items["late"] = row
        #expect(changes.count == 1)
        #expect(items["late"] === row)
    }
}
