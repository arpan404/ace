import Foundation
import Testing
@testable import Ace

/// Bounded coalescing hold for reading-window patches.
@Suite @MainActor struct ReadingHoldTests {
    private func item(_ id: String, text: String, epoch: Int = -1) -> BridgePatch {
        let row = TranscriptRow(id: id, index: 0, type: "message", role: "user", text: text,
                                complete: true, createdAt: 0, agentId: "root", truncated: false,
                                detail: nil, quiet: nil)
        return .item("thread", epoch, id, row, nil)
    }
    private func removal(_ id: String, epoch: Int = -1) -> BridgePatch {
        .item("thread", epoch, id, nil, ItemRemoval(seq: 7, reason: "evicted"))
    }
    private func reset(epoch: Int = -1) -> BridgePatch { .threadReset("thread", epoch, nil, nil) }

    @Test func latestWinsPerKeyAndResetClears() {
        var hold = ReadingHold()
        hold.append(item("a", text: "old"))
        hold.append(item("b", text: "one"))
        hold.append(item("a", text: "new"))
        #expect(hold.count == 2)
        var flushed = hold.take()
        #expect(flushed.count == 2)
        guard case .item(_, _, let first, let row, _) = flushed[0] else { Issue.record("first should be item a"); return }
        #expect(first == "a")
        #expect(row?.text == "new")
        // A reset discards everything before it; deletions are preserved, not resurrected.
        hold.append(item("x", text: "stale"))
        hold.append(reset())
        hold.append(item("y", text: "fresh"))
        hold.append(removal("y"))
        hold.append(item("z", text: "kept"))
        flushed = hold.take()
        #expect(flushed.count == 3)
        guard case .threadReset = flushed[0] else { Issue.record("reset first"); return }
        guard case .item(_, _, let removed, let rowAfter, let info) = flushed[1] else { Issue.record("removal second"); return }
        #expect(removed == "y")
        #expect(rowAfter == nil)
        #expect(info?.reason == "evicted")
    }

    @Test func overflowDiscardsToFreshResetWithoutBlocking() {
        var hold = ReadingHold()
        for index in 0..<(ReadingHold.maxPatches + 10) {
            hold.append(item("item-\(index)", text: "text-\(index)"))
        }
        #expect(hold.needsFresh)
        #expect(hold.isEmpty, "overflow discards to await fresh")
        // Intermediate deltas while awaiting fresh are dropped.
        hold.append(item("late", text: "dropped"))
        #expect(hold.isEmpty)
        #expect(hold.take().isEmpty)
        hold.append(item("after-flush", text: "still dropped"))
        #expect(hold.take().isEmpty, "ending a gesture cannot admit deltas before a fresh reset")
        // The next reset starts a fresh snapshot that can flush bounded.
        hold.append(reset())
        hold.append(item("fresh", text: "here"))
        #expect(!hold.isEmpty)
        let flushed = hold.take()
        #expect(flushed.count == 2)
        #expect(!hold.needsFresh, "fresh snapshot recovers")
    }

    @Test func liveModelHoldsReadingAcrossScrollThenFlushesBounded() throws {
        let model = ClientModel(now: { 0 })
        let reading = ThreadModel(id: "thread")
        reading.epoch = -1
        model.reading = reading
        var first = itemPatch("older", text: "Earlier", index: 0)
        first["epoch"] = -1
        model.beginReadingScroll()
        model.holdReading()
        model.receive(try frame([first]))
        #expect(reading.items.isEmpty, "held during scroll")
        // Streaming the same row coalesces to the latest; the flush stays bounded.
        for index in 0..<50 {
            var update = itemPatch("older", text: "v\(index)", index: 0)
            update["epoch"] = -1
            model.receive(try frame([update]))
        }
        model.endReadingScroll()
        #expect(model.readingNeedsFresh == false)
        model.receive(try frame([["type": "reading.settled", "threadId": "thread", "epoch": -1]]))
        #expect(reading.items["older"]?.row.text == "v49")
    }

    @Test func fullValidHistorySnapshotFlushesAfterOverflow() throws {
        // Overflow with distinct rows, then a full valid window (400 rows plus a
        // block) must still land completely: bounds fit one valid window.
        var hold = ReadingHold()
        for index in 0..<(ReadingHold.maxPatches + 10) {
            hold.append(item("junk-\(index)", text: "junk"))
        }
        #expect(hold.needsFresh)
        hold.append(reset())
        for index in 0..<400 {
            hold.append(item("row-\(index)", text: "Row \(index)"))
            hold.append(.position("thread", -1, "row-\(index)", index))
        }
        for index in 0..<800 {
            hold.append(.block("thread", -1, "block-\(index)", nil))
            hold.append(.blockPosition("thread", -1, "block-\(index)", index))
        }
        let flushed = hold.take()
        #expect(flushed.count == 2401, "a full valid window and its block/position updates fit the bound")
        #expect(!hold.needsFresh)
    }

    @Test func overflowedReadingRecoversOnNextFullPageThroughPublicFrames() throws {
        let model = ClientModel(now: { 0 })
        let reading = ThreadModel(id: "thread")
        reading.epoch = -1
        model.reading = reading
        model.beginReadingScroll()
        model.holdReading()
        // Flood the hold with distinct rows past the bound: it discards to await fresh.
        for index in 0..<(ReadingHold.maxPatches + 10) {
            model.receive(try frame([itemPatch("junk-\(index)", text: "junk", index: index)]))
        }
        #expect(model.readingNeedsFresh, "overflow signals the viewport to re-read")
        #expect(reading.items.isEmpty)
        // The next full page is a fresh snapshot: reset plus a valid window.
        var page: [[String: Any]] = [["type": "thread.reset", "threadId": "thread", "epoch": -1]]
        for index in 0..<400 {
            page.append(itemPatch("row-\(index)", text: "Row \(index)", index: index))
        }
        // The bridge admits at most 32 patches per physical frame.
        for start in stride(from: 0, to: page.count, by: 32) {
            #expect(model.receive(try frame(Array(page[start..<min(start + 32, page.count)]))))
        }
        model.endReadingScroll()
        model.receive(try frame([["type": "reading.settled", "threadId": "thread", "epoch": -1]]))
        #expect(reading.order.count == 400, "a full valid window lands after overflow")
        #expect(reading.items["row-399"]?.row.text == "Row 399")
        #expect(model.readingNeedsFresh == false)
    }

    private func itemPatch(_ id: String, text: String, index: Int) -> [String: Any] {
        ["type": "thread.item", "threadId": "thread", "epoch": -1, "id": id,
         "row": ["id": id, "index": index, "type": "message", "role": "assistant", "text": text,
                 "complete": false, "createdAt": 0, "agentId": "root", "truncated": false]]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }

    @Test func overflowInvokesFreshRereadHookOncePerEpisode() throws {
        let model = ClientModel(now: { 0 })
        let reading = ThreadModel(id: "thread")
        reading.epoch = -1
        model.reading = reading
        var calls = 0
        model.onReadingNeedsFresh = { calls += 1 }
        model.beginReadingScroll()
        model.holdReading()
        for index in 0..<(ReadingHold.maxPatches + 10) {
            model.receive(try frame([itemPatch("junk-\(index)", text: "junk", index: index)]))
        }
        #expect(model.readingNeedsFresh)
        // Still scrolling: no hook until the gesture ends.
        #expect(calls == 0)
        model.endReadingScroll()
        #expect(calls == 0, "the in-flight page must settle before recovery starts")
        model.releaseReading()
        #expect(calls == 1, "overflow wires one fresh re-read after the page and gesture settle")
        // No fresh reset yet: further flushes must not loop the hook.
        model.beginReadingScroll()
        model.endReadingScroll()
        #expect(calls == 1)
    }
}
