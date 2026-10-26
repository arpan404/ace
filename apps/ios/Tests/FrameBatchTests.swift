import Foundation
import Testing
@testable import Ace

/// Frames from the runtime are held and applied together (`FrameBatch`): an update the bridge
/// split over frames lands as one change, and a burst of new rows lands a few times a second
/// rather than once per frame.
@Suite @MainActor struct FrameBatchTests {
    private func row(_ id: String, _ text: String, index: Int) -> [String: Any] {
        ["id": id, "index": index, "type": "message", "role": "assistant", "text": text, "complete": false,
         "createdAt": 0, "agentId": "", "truncated": false, "detail": "", "quiet": false]
    }
    private func patches(_ values: [[String: Any]]) throws -> [BridgePatch] {
        var frames = BridgeFrames()
        return try frames.decode(try JSONSerialization.data(withJSONObject: values))
    }
    private func item(_ epoch: Int, _ id: String, _ text: String, index: Int) -> [String: Any] {
        ["type": "thread.item", "threadId": "thread", "epoch": epoch, "id": id, "row": row(id, text, index: index)]
    }
    private func edit(_ epoch: Int, _ id: String, base: Int, append: String) -> [String: Any] {
        ["type": "thread.item.text", "threadId": "thread", "epoch": epoch, "id": id, "row": row(id, "", index: 0),
         "base": base, "cut": 0, "append": append]
    }

    @Test func framesHeldTogetherApplyAsOneChangeAndAnEditBuildsOnAHeldRow() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        #expect(model.hold(try patches([item(epoch, "a", "Hello", index: 0)]), bytes: 0))
        #expect(model.hold(try patches([edit(epoch, "a", base: 5, append: " world"), item(epoch, "b", "Next", index: 1)]), bytes: 0))
        // Nothing shows until the batch applies; then all of it does.
        #expect(model.thread?.items.isEmpty == true)
        model.flushFrames()
        #expect(model.thread?.items["a"]?.row.text == "Hello world")
        #expect(model.thread?.order == ["a", "b"])
    }

    @Test func anEditAgainstOtherTextIsTurnedDownWhileTheHeldFramesBeforeItStillApply() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        #expect(model.hold(try patches([item(epoch, "a", "Hello", index: 0)]), bytes: 0))
        #expect(!model.hold(try patches([edit(epoch, "a", base: 9, append: " there")]), bytes: 0))
        // The bridge sends the row whole after a refusal; an edit against the held row still applies.
        #expect(model.hold(try patches([edit(epoch, "a", base: 5, append: "!")]), bytes: 0))
        model.flushFrames()
        #expect(model.thread?.items["a"]?.row.text == "Hello!")
    }

    @Test func heldFramesApplyOnTheirOwnWithinMoments() async throws {
        let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        #expect(model.hold(try patches([item(epoch, "a", "Hello", index: 0)]), bytes: 0))
        try await Task.sleep(for: .milliseconds(200))
        #expect(model.thread?.items["a"]?.row.text == "Hello")
    }

    @Test func newRowsInABurstWaitForThePaceWhileOtherChangesKeepTheDisplayFrame() {
        let window = FrameBatch.window, pace = FrameBatch.rowPace
        // The first rows after a quiet spell go a display frame after they arrive.
        #expect(FrameBatch.due(heldSince: 1_000, addsRows: true, rowsAt: nil) == 1_000 + window)
        #expect(FrameBatch.due(heldSince: 1_000, addsRows: true, rowsAt: 1_000 - pace - 50) == 1_000 + window)
        // More rows soon after wait until the pace has passed since the last rows landed.
        #expect(FrameBatch.due(heldSince: 1_000, addsRows: true, rowsAt: 990) == 990 + pace)
        // Edits to rows already shown (streaming text) are never held back by it.
        #expect(FrameBatch.due(heldSince: 1_000, addsRows: false, rowsAt: 990) == 1_000 + window)
    }
}
