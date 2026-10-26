import Foundation
import Testing
@testable import Ace

/// Frames from the runtime are held and applied together (`FrameBatch`): an update the bridge
/// split over frames lands as one change, and a burst of new rows lands a few times a second
/// rather than once per frame. Nothing the bridge was told is shown is ever dropped.
@Suite @MainActor struct FrameBatchTests {
    private func row(_ id: String, _ text: String, index: Int) -> [String: Any] {
        ["id": id, "index": index, "type": "message", "role": "assistant", "text": text, "complete": false,
         "createdAt": 0, "agentId": "", "truncated": false, "detail": "", "quiet": false]
    }
    private func patches(_ values: [[String: Any]]) throws -> [BridgePatch] {
        var frames = BridgeFrames()
        return try frames.decode(try JSONSerialization.data(withJSONObject: values))
    }
    private func item(_ epoch: Int, _ id: String, _ text: String, index: Int, thread: String = "thread") -> [String: Any] {
        ["type": "thread.item", "threadId": thread, "epoch": epoch, "id": id, "row": row(id, text, index: index)]
    }
    private func edit(_ epoch: Int, _ id: String, base: Int, append: String) -> [String: Any] {
        ["type": "thread.item.text", "threadId": "thread", "epoch": epoch, "id": id, "row": row(id, "", index: 0),
         "base": base, "cut": 0, "append": append]
    }
    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    @Test func framesHeldTogetherApplyAsOneChangeAndAnEditBuildsOnAHeldRow() throws {
        let model = ClientModel(now: { 0 }, frames: .immediate)
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
        let model = ClientModel(now: { 0 }, frames: .immediate)
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        #expect(model.hold(try patches([item(epoch, "a", "Hello", index: 0)]), bytes: 0))
        #expect(!model.hold(try patches([edit(epoch, "a", base: 9, append: " there")]), bytes: 0))
        // The bridge sends the row whole after a refusal; an edit against the held row still applies.
        #expect(model.hold(try patches([edit(epoch, "a", base: 5, append: "!")]), bytes: 0))
        model.flushFrames()
        #expect(model.thread?.items["a"]?.row.text == "Hello!")
    }

    @Test func anEditAfterAHeldResetIsTurnedDownUntilTheRowComesAgainWhole() throws {
        let model = ClientModel(now: { 0 }, frames: .immediate)
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        model.receive(try JSONSerialization.data(withJSONObject: [item(epoch, "a", "Hello", index: 0)]))
        #expect(model.hold(try patches([["type": "thread.reset", "threadId": "thread", "epoch": epoch]]), bytes: 0))
        #expect(!model.hold(try patches([edit(epoch, "a", base: 5, append: "!")]), bytes: 0))
        #expect(model.hold(try patches([item(epoch, "a", "Hello again", index: 0)]), bytes: 0))
        model.flushFrames()
        #expect(model.thread?.items["a"]?.row.text == "Hello again")
    }

    @Test func heldFramesApplyOnTheirOwnEvenWhileTimeStandsStill() async throws {
        let model = ClientModel(now: { 0 }, frames: .immediate)
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        #expect(model.hold(try patches([item(epoch, "a", "Hello", index: 0)]), bytes: 0))
        await settle()
        #expect(model.thread?.items["a"]?.row.text == "Hello")
    }

    @Test func leavingAThreadMidBatchKeepsWhatWasHeldForWhenItOpensAgain() throws {
        let model = ClientModel(now: { 0 }, frames: .immediate)
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        model.receive(try JSONSerialization.data(withJSONObject: [["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 0]]))
        #expect(model.hold(try patches([item(epoch, "a", "Approved and finished", index: 0)]), bytes: 0))
        // The bridge was told this frame is shown: going elsewhere first must not lose it.
        model.open("other")
        model.open("thread")
        #expect(model.thread?.items["a"]?.row.text == "Approved and finished")
        model.back()
        #expect(model.thread == nil)
    }

    @Test func disconnectingMidBatchAppliesWhatWasHeldBeforeTheRuntimeEnds() throws {
        let model = ClientModel(now: { 0 }, frames: .immediate)
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        #expect(model.hold(try patches([item(epoch, "a", "Last words", index: 0)]), bytes: 0))
        model.disconnect()
        #expect(model.thread?.items["a"]?.row.text == "Last words")
    }

    @Test func aBurstOfNewRowsLandsAtThePaceWhileEditsToShownRowsDoNot() async throws {
        let time = ManualTime()
        let model = ClientModel(now: { 0 }, frames: time.timing)
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        model.receive(try JSONSerialization.data(withJSONObject: [["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 0]]))
        // The first new row after a quiet spell shows a display frame later.
        #expect(model.hold(try patches([item(epoch, "a", "Read relay.ts", index: 0)]), bytes: 0))
        await settle()
        #expect(model.thread?.items["a"] == nil)
        time.advance(to: FrameBatch.window)
        await settle()
        #expect(model.thread?.items["a"] != nil)
        // The next one, soon after, waits until the pace has passed since the last rows landed.
        time.advance(to: 40)
        #expect(model.hold(try patches([item(epoch, "b", "Ran the tests", index: 1)]), bytes: 0))
        await settle()
        time.advance(to: 40 + FrameBatch.window)
        await settle()
        #expect(model.thread?.items["b"] == nil)
        time.advance(to: FrameBatch.window + FrameBatch.rowPace)
        await settle()
        #expect(model.thread?.items["b"] != nil)
        // Streaming into a row already shown keeps the display frame's pace.
        let at = time.now + 5
        time.advance(to: at)
        #expect(model.hold(try patches([edit(epoch, "a", base: 13, append: " again")]), bytes: 0))
        await settle()
        time.advance(to: at + FrameBatch.window)
        await settle()
        #expect(model.thread?.items["a"]?.row.text == "Read relay.ts again")
    }
}

/// A clock that moves only when the test says, and waits that end when it reaches them.
@MainActor private final class ManualTime: @unchecked Sendable {
    private(set) var now = 0.0
    private var sleepers: [(until: Double, resume: CheckedContinuation<Void, Never>)] = []
    var timing: FrameTiming {
        FrameTiming(now: { [unowned self] in now }, wait: { [unowned self] ms in await sleep(ms) })
    }
    private func sleep(_ ms: Double) async {
        guard ms > 0 else { return }
        await withCheckedContinuation { sleepers.append((now + ms, $0)) }
    }
    func advance(to time: Double) {
        now = time
        let woken = sleepers.filter { $0.until <= time }
        sleepers.removeAll { $0.until <= time }
        for sleeper in woken { sleeper.resume.resume() }
    }
}
