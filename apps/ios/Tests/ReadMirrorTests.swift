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

    @Test func aScreensOwnAnswerIsNotLateButOneAfterItStoppedWaitingIsAndEvictionIsNeither() async throws {
        let model = ClientModel(now: { 0 })
        let key = try #require(ReadMirror.key(Self.list))
        func reply(_ id: String) throws -> Data {
            try frame([["type": "service.reply", "id": id, "ok": true, "message": "",
                        "value": ["result": ["kind": "list"]], "cache": ["key": key, "family": "prompts"]]])
        }
        let stop = model.watchRead(Self.list)
        let waiting = Task { try await model.services.wait(id: "native-1") { true } }
        while !model.services.isWaiting("native-1") { await Task.yield() }
        model.receive(try reply("native-1"))
        _ = try await waiting.value
        #expect(model.lateKept(Self.list) == 0)

        // Replacing the entry after nothing waits for it moves the revision each time.
        model.receive(try reply("native-2"))
        let first = model.lateKept(Self.list)
        #expect(first > 0)
        model.receive(try reply("native-3"))
        #expect(model.lateKept(Self.list) > first)

        let settled = model.lateKept(Self.list)
        model.receive(try frame([["type": "service.evict", "key": key]]))
        #expect(model.lateKept(Self.list) == settled)

        stop()
    }

    @Test func anAnswerNobodyIsWatchingLeavesNoLateRevisionBehind() throws {
        let model = ClientModel(now: { 0 })
        let key = try #require(ReadMirror.key(Self.list))
        model.receive(try frame([["type": "service.cache", "key": key, "family": "prompts", "value": ["result": ["kind": "list"]]]]))
        #expect(model.reads.lateRevisions.isEmpty)
        let stop = model.watchRead(Self.list)
        model.receive(try frame([["type": "service.cache", "key": key, "family": "prompts", "value": ["result": ["kind": "list"]]]]))
        #expect(model.lateKept(Self.list) > 0)
        stop()
        #expect(model.reads.lateRevisions.isEmpty)
    }

    @Test func aWatchedReadsGenerationHoldsAcrossItsFirstAnswerAndAnEviction() throws {
        let model = ClientModel(now: { 0 })
        let key = try #require(ReadMirror.key(Self.list))
        model.receive(try frame([["type": "service.generations", "generations": ["prompts": 3, "reconnects": 1]]]))
        let stop = model.watchRead(Self.list)
        let before = model.readGeneration(Self.list)
        model.receive(try frame([["type": "service.cache", "key": key, "family": "prompts", "value": ["result": ["kind": "list"]]]]))
        #expect(model.readGeneration(Self.list) == before)
        model.receive(try frame([["type": "service.evict", "key": key]]))
        #expect(model.readGeneration(Self.list) == before)
        model.receive(try frame([["type": "service.generations", "generations": ["prompts": 4, "reconnects": 1]]]))
        #expect(model.readGeneration(Self.list) == before + 1)
        stop()
    }

    @Test func pullToRefreshNamesTheSameReadAsAnOrdinaryVisit() {
        let page: [String: Any] = ["type": "forge.pulls", "project": "p", "screens": 1]
        var refreshing = page
        refreshing["fresh"] = true
        #expect(ReadMirror.key(page) == ReadMirror.key(refreshing))
    }

    private struct Measurement: Decodable { let databaseBytes: Int }
    @Test func forcedStorageRefreshReplacesTheOrdinaryVisitsKeptPage() throws {
        let model = ClientModel(now: { 0 })
        let page: [String: Any] = ["type": "host.storage"]
        let refresh: [String: Any] = ["type": "host.storage", "force": true]
        let initialKey = try #require(ReadMirror.key(page))
        model.receive(try frame([["type": "service.cache", "key": initialKey, "family": "host",
                                  "value": ["databaseBytes": 100]]]))
        let refreshedKey = try #require(ReadMirror.key(refresh))
        model.receive(try frame([["type": "service.reply", "id": "storage-refresh", "ok": true, "message": "",
                                  "value": ["databaseBytes": 200], "cache": ["key": refreshedKey, "family": "host"]]]))
        #expect(model.kept(page, as: Measurement.self)?.databaseBytes == 200)
    }

    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
}
