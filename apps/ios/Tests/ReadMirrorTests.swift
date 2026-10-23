import Foundation
import Testing
@testable import Ace

/// Screens draw the bridge's kept reads in their first frame (`bridge/native-reads.ts`).
@MainActor @Suite struct ReadMirrorTests {
    private struct Prompts: Decodable, Equatable { struct Result: Decodable, Equatable { let kind: String }; let result: Result }
    private static let list: [String: Any] = ["type": "prompts.request", "operation": ["op": "list"]]

    @Test func aKeptAnswerTheBridgeSentIsDrawnForTheSameRequestNextVisit() throws {
        let model = ClientModel(now: { 0 })
        #expect(model.kept(Self.list, as: Prompts.self) == nil)
        let key = try #require(ReadMirror.key(Self.list))
        model.receive(try frame([["type": "service.reply", "id": "native-1", "ok": true, "message": "",
                                  "value": ["result": ["kind": "list"]], "cache": ["key": key, "family": "prompts"]]]))
        // The same request written with its keys in another order names the same read.
        let reordered: [String: Any] = ["operation": ["op": "list"], "type": "prompts.request"]
        #expect(model.kept(reordered, as: Prompts.self) == Prompts(result: .init(kind: "list")))
    }

    @Test func anAnswerTheBridgeStopsKeepingIsNoLongerDrawn() throws {
        let model = ClientModel(now: { 0 })
        let key = try #require(ReadMirror.key(Self.list))
        model.receive(try frame([["type": "service.cache", "key": key, "family": "prompts", "value": ["result": ["kind": "list"]]]]))
        #expect(model.kept(Self.list, as: Prompts.self) != nil)
        model.receive(try frame([["type": "service.evict", "key": key]]))
        #expect(model.kept(Self.list, as: Prompts.self) == nil)
        #expect(model.reads.values[key] == nil)
    }

    @Test func pastItsBudgetTheMirrorLetsTheOldestAnswersGoAndKeepsTheNewest() {
        let mirror = ReadMirror(budget: 300)
        let text = ServiceValue.string(String(repeating: "x", count: 200))
        mirror.store(key: "old", family: "prompts", value: text)
        mirror.store(key: "new", family: "prompts", value: text)
        #expect(mirror.value("old", as: String.self) == nil)
        #expect(mirror.value("new", as: String.self)?.count == 200)
    }

    @Test func aScreenWhoseFirstReadFailedWhileAwayReadsAgainWhenTheMachineComesBack() throws {
        let model = ClientModel(now: { 0 })
        let before = model.readGeneration(Self.list)
        // Nothing kept for this read; another family changing is no reason to read it again.
        model.receive(try frame([["type": "service.generations", "generations": ["usage": 1]]]))
        #expect(model.readGeneration(Self.list) == before)
        model.receive(try frame([["type": "service.generations", "generations": ["usage": 2, "reconnects": 1]]]))
        #expect(model.readGeneration(Self.list) != before)
    }

    @Test func anAnswerTheBridgeDidNotKeepIsNeverDrawnFromTheCache() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([["type": "service.reply", "id": "native-1", "ok": true, "message": "", "value": ["result": ["kind": "list"]]]]))
        #expect(model.kept(Self.list, as: Prompts.self) == nil)
    }

    @Test func answersRestoredFromAnEarlierLaunchAreDrawnAndTheirFamilysGenerationAsksAgain() throws {
        let model = ClientModel(now: { 0 })
        let key = try #require(ReadMirror.key(Self.list))
        model.receive(try frame([["type": "service.cache", "key": key, "family": "prompts", "value": ["result": ["kind": "list"]]]]))
        #expect(model.kept(Self.list, as: Prompts.self) != nil)
        let before = model.readGeneration(Self.list)
        model.receive(try frame([["type": "service.generations", "generations": ["usage": 4]]]))
        #expect(model.readGeneration(Self.list) == before)
        model.receive(try frame([["type": "service.generations", "generations": ["usage": 4, "prompts": 1]]]))
        #expect(model.readGeneration(Self.list) == before + 1)
    }

    @Test func pullToRefreshNamesTheSameReadAsAnOrdinaryVisit() {
        let page: [String: Any] = ["type": "forge.pulls", "project": "p", "screens": 1]
        var refreshing = page
        refreshing["fresh"] = true
        #expect(ReadMirror.key(page) == ReadMirror.key(refreshing))
    }

    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
}
