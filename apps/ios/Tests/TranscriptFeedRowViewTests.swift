import Foundation
import Testing
@testable import Ace

/// The feed skips re-rendering a row whose data hasn't changed: a re-evaluated feed builds new
/// links (new closures) for every row, and comparing those as different re-rendered every row on
/// screen, markdown and chips included (#2051).
@Suite @MainActor struct TranscriptFeedRowViewTests {
    private func block(_ id: String) throws -> BlockModel {
        let json: [String: Any] = ["index": 0, "kind": "message", "items": ["\(id)-item"], "headed": false, "interactionId": ""]
        return BlockModel(id: id, row: try JSONDecoder().decode(BlockRow.self, from: JSONSerialization.data(withJSONObject: json)))
    }
    /// Links as a re-evaluated feed builds them: every closure new.
    private func links(steps: StepsLinks? = nil, changes: Bool = true) -> TranscriptLinks {
        TranscriptLinks(openThread: { _ in }, openAgent: { _ in }, steps: steps, openMedia: { _ in },
                        openChanges: changes ? {} : nil, openMessage: { _ in }, openAgents: {},
                        threadStatus: { _ in nil }, threadTitle: { _ in nil })
    }
    private func view(_ block: BlockModel, thread: ThreadModel, room: CGFloat = 8, links: TranscriptLinks) -> TranscriptFeedRowView {
        TranscriptFeedRowView(row: TranscriptFeedRow(id: "block:\(block.id)", block: block, room: room), thread: thread, links: links)
    }
    private func client() -> ClientModel {
        ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in fatalError("never connected") })
    }

    @Test func aRowBuiltAgainFromTheSameDataWithNewClosuresIsTheSameRow() throws {
        let thread = ThreadModel(id: "a")
        let shown = try block("one")
        #expect(view(shown, thread: thread, links: links()) == view(shown, thread: thread, links: links()))
        let model = client()
        let steps = StepsLinks(model: model, screen: thread.screen, epoch: 2)
        let again = StepsLinks(model: model, screen: thread.screen, epoch: 2)
        #expect(view(shown, thread: thread, links: links(steps: steps)) == view(shown, thread: thread, links: links(steps: again)))
    }

    @Test func aRowForAnotherBlockOrThreadOrRoomIsRenderedAgain() throws {
        let thread = ThreadModel(id: "a")
        let shown = try block("one")
        let base = view(shown, thread: thread, links: links())
        // The same block id in a new model (a window rebuilt) is new data.
        #expect(base != view(try block("one"), thread: thread, links: links()))
        #expect(base != view(shown, thread: ThreadModel(id: "a"), links: links()))
        #expect(base != view(shown, thread: thread, room: 24, links: links()))
    }

    @Test func aRowWhoseLinksLeadSomewhereElseIsRenderedAgain() throws {
        let thread = ThreadModel(id: "a")
        let shown = try block("one")
        let model = client()
        let first = view(shown, thread: thread, links: links(steps: StepsLinks(model: model, screen: thread.screen, epoch: 1)))
        // A new generation of the thread reads its steps elsewhere.
        #expect(first != view(shown, thread: thread, links: links(steps: StepsLinks(model: model, screen: thread.screen, epoch: 2))))
        #expect(first != view(shown, thread: thread, links: links(steps: StepsLinks(model: model, screen: ThreadScreenModel(), epoch: 1))))
        #expect(first != view(shown, thread: thread, links: links(steps: nil)))
        // Changes that can't be opened any more take the row's chips' action away.
        #expect(view(shown, thread: thread, links: links()) != view(shown, thread: thread, links: links(changes: false)))
    }
}
