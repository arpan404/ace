import Foundation
import SwiftUI
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

    @Test func aFlingToTheOlderLimitStillHasLoadedHistoryInView() throws {
        let thread = ThreadModel(id: "a")
        thread.loaded = true
        thread.screen.hasOlder = true
        thread.screen.blocks["kept"] = try block("kept")
        thread.screen.blockOrder = ["kept"]
        let feed = ConversationFeed(model: client(), thread: thread, acceptedSend: 0, links: links(),
                                    keyboard: KeyboardRide(), behind: .constant(false))
        feed.extent.update(["block:evicted", "block:kept"], movement: .replace)
        feed.extent.measure("block:evicted", height: 5_000)
        feed.extent.update(["block:kept"], movement: .newer)

        let entries = feed.entries(TranscriptSurface())
        var geometry = TranscriptStackGeometry()
        geometry.replace(entries.map(\.id), declared: Dictionary(uniqueKeysWithValues: entries.compactMap { entry in
            entry.height.map { (entry.id, $0) }
        }), estimate: { _ in 400 })
        let viewport: CGFloat = 800
        let limit = max(0, geometry.contentHeight - viewport)
        let visible = geometry.indices(from: limit, to: limit + viewport)
        #expect(visible.contains { entries[$0].isRow })
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
