import Foundation
import Testing
@testable import Ace

/// Viewport, extent, session and freshness behavior: public anchor/extent
/// outcomes for delete/eviction/rehydration/resize/lifecycle, plus
/// consume-once evidence and sequence-grounded distant segments.
@MainActor @Suite struct TranscriptViewportSessionTests {
    // MARK: - Extent: explicit eviction vs deletion

    @Test func deletedEdgeRowsLeaveNoPhantomSpace() {
        let extent = TranscriptExtent()
        extent.update(["deleted-answer", "remaining-answer"], movement: .replace)
        extent.measure("deleted-answer", height: 120)
        extent.measure("remaining-answer", height: 80)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["remaining-answer"], movement: .newer,
            evicted: [], deleted: ["deleted-answer"]))
        #expect(extent.before == 0)
        #expect(extent.after == 0)
    }

    @Test func ambiguousMissingRowsDropWithoutEvidence() {
        // Canonical streaming with no fresh service list: a missing block is
        // ambiguous, so it must drop, never retain.
        let extent = TranscriptExtent()
        extent.update(["a", "b"], movement: .replace)
        extent.measure("a", height: 100)
        extent.measure("b", height: 100)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["b"], movement: .newer, evicted: [], deleted: []))
        #expect(extent.before == 0)
        #expect(extent.after == 0)
    }

    @Test func remeasuringTrailingRowKeepsLatestHeight() {
        // Regression: the trailing branch subtracted the new height instead of
        // adjusting by the delta, collapsing retained space on remeasure.
        let extent = TranscriptExtent()
        extent.update(["block:a", "block:b"], movement: .replace)
        extent.measure("block:a", height: 100)
        extent.measure("block:b", height: 200)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:a"], movement: .newer, evicted: ["block:b"]))
        #expect(extent.after == 200)
        extent.measure("block:b", height: 250)
        #expect(extent.after == 250)
        extent.measure("block:b", height: 250)
        #expect(extent.after == 250)
    }

    @Test func previousAndNextSpansMirrorBridgeReply() {
        // The bridge sends previous-window spans for evicted blocks plus
        // next-window spans for resident blocks in one dict; next wins on
        // reused IDs. Eviction folds from the previous span.
        let extent = TranscriptExtent()
        extent.update(["block:a", "block:b"], movement: .replace)
        extent.measure("block:a", height: 120)
        extent.measure("block:b", height: 80)
        extent.measure("block:c", height: 60)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:b", "block:c"], movement: .newer,
            evicted: ["block:a"], deleted: [],
            spans: ["a": BlockSeqSpan(first: 1, last: 10),
                    "b": BlockSeqSpan(first: 11, last: 20),
                    "c": BlockSeqSpan(first: 21, last: 30)]))
        #expect(extent.before == 120)
        #expect(extent.segmentCount == 1)
        #expect(extent.segmentRows == 1)
    }

    @Test func evictedSpanFoldsIntoSequenceSegment() {
        let extent = TranscriptExtent()
        extent.update(["block:a", "block:b"], movement: .replace)
        extent.measure("block:a", height: 120)
        extent.measure("block:b", height: 80)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:b"], movement: .newer,
            evicted: ["block:a"], deleted: [],
            spans: ["a": BlockSeqSpan(first: 1, last: 10),
                    "b": BlockSeqSpan(first: 11, last: 20)]))
        #expect(extent.before == 120)
        #expect(extent.after == 0)
        #expect(extent.segmentCount == 1)
        #expect(extent.segmentRows == 1)
    }

    @Test func interleavedSpanNeverRetainsSpace() {
        // A span overlapping the new window is a regroup overlap, not an
        // eviction: drop it even when listed as evicted.
        let extent = TranscriptExtent()
        extent.update(["block:a", "block:b"], movement: .replace)
        extent.measure("block:a", height: 120)
        extent.measure("block:b", height: 80)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:b"], movement: .newer,
            evicted: ["block:a"], deleted: [],
            spans: ["a": BlockSeqSpan(first: 5, last: 15),
                    "b": BlockSeqSpan(first: 11, last: 20)]))
        #expect(extent.before == 0)
        #expect(extent.segmentCount == 0)
    }

    @Test func rehydratedRangeShrinksTheSegment() {
        let extent = TranscriptExtent()
        extent.update(["block:a", "block:b"], movement: .replace)
        extent.measure("block:a", height: 120)
        extent.measure("block:b", height: 80)
        let spans = ["a": BlockSeqSpan(first: 1, last: 10),
                     "b": BlockSeqSpan(first: 11, last: 20)]
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:b"], movement: .newer, evicted: ["block:a"], spans: spans))
        #expect(extent.before == 120)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:a", "block:b"], movement: .older, evicted: [], spans: spans))
        #expect(extent.before == 0)
        #expect(extent.segmentCount == 0)
    }

    @Test func distantSegmentsStayBoundedAndExact() {
        let extent = TranscriptExtent()
        extent.update(["block:b0"], movement: .replace)
        var total = 0.0
        for page in 0..<100 {
            let id = "block:b\(page)"
            let next = "block:b\(page + 1)"
            extent.update(change: TranscriptExtent.WindowChange(
                ids: [next], movement: .newer, evicted: [id],
                spans: [String(next.dropFirst(6)): BlockSeqSpan(first: (page + 1) * 100, last: (page + 1) * 100 + 50),
                        String(id.dropFirst(6)): BlockSeqSpan(first: page * 100, last: page * 100 + 50)]))
            total += TranscriptExtent.fallbackEstimate
        }
        #expect(extent.segmentCount <= TranscriptExtent.maxSegments)
        // Counts are preserved exactly across merges; heights use the stable
        // estimate for unmeasured rows.
        #expect(extent.before == total)
    }

    @Test func bridgeCountsGroundRetainedSpace() {
        let extent = TranscriptExtent()
        let spans = ["a": BlockSeqSpan(first: 1, last: 10),
                     "b": BlockSeqSpan(first: 20, last: 30),
                     "c": BlockSeqSpan(first: 100, last: 110)]
        extent.update(["block:a", "block:b", "block:c"], movement: .replace)
        extent.measure("block:a", height: 100)
        extent.measure("block:b", height: 200)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:c"], movement: .newer, evicted: ["block:a", "block:b"], spans: spans))
        #expect(extent.before == 300)
        #expect(extent.segmentRows == 2)
        // A fresh count can shrink distant space without changing resident IDs.
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:c"], movement: .newer, beforeCount: 1, spans: spans))
        #expect(extent.before == 200)
        #expect(extent.segmentRows == 1)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:c"], movement: .newer, beforeCount: 0, spans: spans))
        #expect(extent.before == 0)
        #expect(extent.segmentRows == 0)
    }

    @Test func layoutRevisionRescalesSegmentsByCount() {
        let extent = TranscriptExtent()
        let spans = ["a": BlockSeqSpan(first: 1, last: 10),
                     "b": BlockSeqSpan(first: 20, last: 30),
                     "c": BlockSeqSpan(first: 100, last: 110)]
        extent.update(["block:a", "block:b", "block:c"], movement: .replace)
        extent.measure("block:a", height: 100)
        extent.measure("block:b", height: 200)
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ["block:c"], movement: .newer, evicted: ["block:a", "block:b"], spans: spans))
        #expect(extent.before == 300)
        var next = extent.revision
        next.width = 999
        extent.applyRevision(next)
        #expect(extent.before == 88)
        #expect(extent.segmentRows == 2)
    }

    // MARK: - Evidence consume-once

    private func bridgeReply(
        evictedLeading: [String]? = nil, evictedTrailing: [String]? = nil,
        deleted: [String]? = nil, beforeSeq: Int? = nil, afterSeq: Int? = nil,
        beforeCount: Int? = nil, afterCount: Int? = nil,
        blockSeqs: [String: BlockSeqSpan]? = nil,
        freshness: TranscriptFreshness? = nil
    ) -> TranscriptReadingReply {
        TranscriptReadingReply(active: true, hasOlder: true, hasNewer: true,
            joined: false, focus: nil, count: 3, freshness: freshness,
            evictedLeading: evictedLeading, evictedTrailing: evictedTrailing,
            deleted: deleted, beforeSeq: beforeSeq, afterSeq: afterSeq,
            beforeCount: beforeCount, afterCount: afterCount, blockSeqs: blockSeqs)
    }

    @Test func replyEvidenceConsumesOnce() {
        let reading = TranscriptReading()
        // Through the production reply path, not a test-only setter.
        reading.applyReply(bridgeReply(
            evictedLeading: ["a"], beforeSeq: 1, afterSeq: 99,
            beforeCount: 5, afterCount: 0,
            blockSeqs: ["a": BlockSeqSpan(first: 1, last: 10)]), operation: "older")
        #expect(reading.hasFreshWindowEvidence)
        #expect(reading.isStale == false)
        let first = reading.takeWindowEvidence()
        #expect(first.evictedLeading == ["a"])
        #expect(first.beforeSeq == 1)
        #expect(!reading.hasFreshWindowEvidence)
        // Cursors and counts persist for grounding; the lists do not.
        let second = reading.takeWindowEvidence()
        #expect(second.evictedLeading == nil)
        #expect(second.beforeSeq == 1)
        #expect(second.blockSeqs?["a"]?.first == 1)
    }

    @Test func cachedReplyKeepsStaleUntilCurrentLands() {
        let reading = TranscriptReading()
        reading.applyReply(bridgeReply(freshness: .cached), operation: "older")
        #expect(reading.isStale)
        reading.applyReply(bridgeReply(freshness: .cached), operation: "older")
        #expect(reading.isStale)
        reading.applyReply(bridgeReply(freshness: .current), operation: "older")
        #expect(!reading.isStale)
    }

    // MARK: - Viewport controller

    @Test func upwardGestureLeavesFollowingAndDownwardAtEndReturns() {
        var controller = TranscriptViewportController()
        #expect(controller.mode == .following)
        controller.gesture(upward: true, atEnd: true, detached: false, now: 0)
        #expect(controller.mode == .reading)
        controller.scrolled(atEnd: true, upward: false, detached: false, gliding: false)
        #expect(controller.mode == .following)
    }

    @Test func gestureCancelsPendingCorrectionAndJumpReaim() {
        var controller = TranscriptViewportController()
        controller.jump(rowID: "row-1", itemID: "item-1", top: 10, now: 1000)
        #expect(controller.isAiming)
        controller.gesture(upward: true, atEnd: false, detached: false, now: 2000)
        #expect(!controller.isAiming)
        #expect(controller.mode == .reading)
    }

    @Test func heldRowDriftBecomesABoundedShift() {
        var controller = TranscriptViewportController()
        controller.userLeftEnd()
        controller.noteCaptured(rowID: "row-1", itemID: "item-1", top: 10)
        let result = controller.residentChanged(
            newKeys: ["row-0", "row-1"],
            locate: { $0 == "row-1" ? (key: "row-1", index: 1, top: 30) : nil },
            successorOf: { _ in nil }, now: 0)
        #expect(result == .shift(by: 20))
        controller.noteCorrectionApplied()
        controller.gesture(upward: true, atEnd: false, detached: false, now: 0)
        #expect(controller.pendingShift == nil)
    }

    @Test func deletedAnchorHandsOverToItsSuccessor() {
        var controller = TranscriptViewportController()
        controller.userLeftEnd()
        controller.noteCaptured(rowID: "row-1", itemID: "item-1", top: 10)
        let result = controller.residentChanged(
            newKeys: ["row-2", "row-3"],
            locate: { _ in nil },
            successorOf: { $0 == "row-1" ? (key: "row-2", index: 0, top: 12) : nil },
            now: 0)
        #expect(result == .shift(by: 2))
        #expect(controller.held?.rowID == "row-2")
    }

    @Test func regroupedRowIsFoundByItemIdentity() {
        var controller = TranscriptViewportController()
        controller.userLeftEnd()
        controller.noteCaptured(rowID: "block-1", itemID: "item-9", top: 5)
        let result = controller.residentChanged(
            newKeys: ["block-7"],
            locate: { key in key == "item-9" || key == "block-7" ? (key: "block-7", index: 0, top: 5) : nil },
            successorOf: { _ in nil }, now: 0)
        #expect(result == .none)
    }

    @Test func desiredHeldTopSurvivesSequentialDriftEvents() {
        // The correction moves the view, never the target: sequential
        // remeasurements without a fresh capture keep correcting toward the
        // same desired offset until a capture (or gesture) moves it.
        var controller = TranscriptViewportController()
        controller.userLeftEnd()
        controller.noteCaptured(rowID: "row-1", itemID: "item-1", top: 10)
        let first = controller.residentChanged(
            newKeys: ["row-0", "row-1"],
            locate: { $0 == "row-1" ? (key: "row-1", index: 1, top: 30) : nil },
            successorOf: { _ in nil }, now: 0)
        #expect(first == .shift(by: 20))
        #expect(controller.held?.top == 10)
        // Same geometry again, no new capture: still owed, same target.
        let second = controller.residentChanged(
            newKeys: ["row-0", "row-1"],
            locate: { $0 == "row-1" ? (key: "row-1", index: 1, top: 30) : nil },
            successorOf: { _ in nil }, now: 0)
        #expect(second == .shift(by: 20))
        #expect(controller.held?.top == 10)
        // A fresh observation moves the target; drift against it is none.
        controller.noteCaptured(rowID: "row-1", itemID: "item-1", top: 30)
        let third = controller.residentChanged(
            newKeys: ["row-0", "row-1"],
            locate: { $0 == "row-1" ? (key: "row-1", index: 1, top: 30) : nil },
            successorOf: { _ in nil }, now: 0)
        #expect(third == .none)
    }

    @Test func successorHandoverKeepsDesiredOffset() {
        var controller = TranscriptViewportController()
        controller.userLeftEnd()
        controller.noteCaptured(rowID: "row-1", itemID: "item-1", top: 10)
        let result = controller.residentChanged(
            newKeys: ["row-2", "row-3"],
            locate: { _ in nil },
            successorOf: { $0 == "row-1" ? (key: "row-2", index: 0, top: 12) : nil },
            now: 0)
        #expect(result == .shift(by: 2))
        #expect(controller.held?.rowID == "row-2")
        #expect(controller.held?.top == 10)
    }

    @Test func sessionRestoreFractionPlacesSavedOffset() {
        var controller = TranscriptViewportController()
        #expect(controller.sessionRestoreFraction(viewport: 800, topInset: 100, bottomInset: 100, rowHeight: 50) == nil)
        controller.noteSessionAnchor(TranscriptHeldAnchor(rowID: "row-9", itemID: "item-9", top: 200))
        // (200) / (800 - 100 - 100 - 50).
        let fraction = controller.sessionRestoreFraction(viewport: 800, topInset: 100, bottomInset: 100, rowHeight: 50)
        #expect(fraction != nil)
        #expect(abs((fraction ?? -1) - 200 / 550) < 0.0001)
        #expect(controller.sessionRestoreFraction(viewport: 800, topInset: 100, bottomInset: 100, rowHeight: 600) == nil)
        controller.noteSessionAnchor(TranscriptHeldAnchor(rowID: "row-9", itemID: "item-9", top: -120))
        #expect(controller.sessionRestoreFraction(viewport: 800, topInset: 100, bottomInset: 100, rowHeight: 900) == 0.4)
        // A partly clipped short row requires a negative alignment fraction.
        controller.noteSessionAnchor(TranscriptHeldAnchor(rowID: "row-9", itemID: "item-9", top: -55))
        #expect(controller.sessionRestoreFraction(viewport: 800, topInset: 100, bottomInset: 100, rowHeight: 50) == -0.1)
    }

    @Test func layoutChangesKeepTheSavedMessageAndPixelOffset() {
        var controller = TranscriptViewportController()
        controller.userLeftEnd()
        let saved = TranscriptHeldAnchor(rowID: "row-9", itemID: "item-9", top: -120)
        controller.noteSessionAnchor(saved)
        var revision = controller.revision
        revision.width = 400
        _ = controller.layoutChanged(to: revision)
        #expect(controller.sessionAnchor == saved)
        #expect(controller.held == saved)
        #expect(controller.mode == .reading)
    }

    @Test func sessionRestoreCancelsOnGestureOrBudget() {
        var controller = TranscriptViewportController()
        controller.noteSessionAnchor(TranscriptHeldAnchor(rowID: "row-9", itemID: "item-9", top: 200))
        controller.gesture(upward: true, atEnd: false, detached: false, now: 0)
        #expect(controller.sessionAnchor == nil)
        controller.noteSessionAnchor(TranscriptHeldAnchor(rowID: "row-9", itemID: "item-9", top: 200))
        for _ in 0..<TranscriptViewportController.maxCorrectionFrames {
            controller.noteCorrectionApplied()
        }
        #expect(controller.sessionAnchor == nil)
    }

    @Test func revisionIgnoresResidentContentCounts() {
        // Paging and streaming must not invalidate measurements: the revision
        // is geometry only, so identical geometry compares equal.
        let a = TranscriptLayoutRevision.current(width: 400, height: 800, typeSize: "large", density: "d1", disclosures: 2)
        let b = TranscriptLayoutRevision.current(width: 400, height: 800, typeSize: "large", density: "d1", disclosures: 2)
        #expect(a == b)
        var c = b
        c.width = 500
        #expect(a != c)
    }

    // MARK: - Sessions

    @Test func liveSessionsAreForgottenAndHistoryIsBounded() {
        var store = TranscriptSessionStore()
        store.save(TranscriptReadingSession.live(threadID: "t", machineID: "m", now: 0))
        #expect(store.count == 0)
        for index in 0..<(TranscriptSessionStore.capacity + 5) {
            store.save(TranscriptReadingSession(
                threadID: "t-\(index)", machineID: "m", mode: .reading,
                anchor: TranscriptHeldAnchor(rowID: "row", itemID: "item", top: 0),
                lastKey: "row", paged: true, updatedAt: Double(index)))
        }
        #expect(store.count == TranscriptSessionStore.capacity)
        #expect(store.recall(threadID: "t-0", machineID: "m") == nil)
        #expect(store.recall(threadID: "t-\(TranscriptSessionStore.capacity + 4)", machineID: "m") != nil)
    }

    @Test func restoreSurvivesNewArrivalsAndMissingRows() {
        var store = TranscriptSessionStore()
        store.save(TranscriptReadingSession(
            threadID: "t", machineID: "m", mode: .reading,
            anchor: TranscriptHeldAnchor(rowID: "row-1", itemID: "item-1", top: 0),
            lastKey: "row-9", paged: true, updatedAt: 0))
        // New arrivals since (changed last key) and a live tail that no longer
        // holds the row: the position still restores around the saved item.
        #expect(store.restorable(threadID: "t", machineID: "m") != nil)
        #expect(store.restorable(threadID: "other", machineID: "m") == nil)
    }

    // MARK: - Freshness

    @Test func cachedReplyMarksStaleAndCurrentClearsIt() {
        let reading = TranscriptReading()
        reading.applyFreshness(.cached)
        #expect(reading.isStale)
        reading.applyFreshness(.current)
        #expect(!reading.isStale)
        reading.applyFreshness(nil)
        #expect(!reading.isStale)
    }

    // MARK: - Keyboard

    @Test func floatingKeyboardBesideTheColumnLiftsNothing() {
        let lift = TranscriptKeyboardLift.overlap(
            feedMinX: 0, feedMaxX: 400, feedBottom: 800,
            keyboardMinX: 500, keyboardMaxX: 900, keyboardMinY: 600)
        #expect(lift == 0)
        let docked = TranscriptKeyboardLift.overlap(
            feedMinX: 0, feedMaxX: 400, feedBottom: 800,
            keyboardMinX: 0, keyboardMaxX: 400, keyboardMinY: 600)
        #expect(docked == 200)
    }
}
