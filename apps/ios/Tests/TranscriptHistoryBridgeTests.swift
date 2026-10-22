import Foundation
import JavaScriptCore
import Testing
@testable import Ace
@Suite @MainActor struct TranscriptHistoryBridgeTests {
    @Test func olderPagesMoveTheCursorWithNoDupes() throws {
        let harness = try HistoryHarness()
        let result = try harness.run("transcriptHistoryOlderPages", snapshot: "older-pages")
        #expect(result.ok, "JS error: \(result.errorText)")
        let detail = result.detail
        let pages = detail.int("pages")
        let counts = detail.numbers("counts")
        let firstSeqs = detail.numbers("firstSeqs")
        #expect(pages >= 2)
        #expect(counts.allSatisfy { $0 <= 2200 })
        // Successive windows overlap (older pages prepend): shared items must keep their
        // order and sequence, and only older items may appear.
        #expect(detail.bool("allSequenced"))
        #expect(zip(firstSeqs, firstSeqs.dropFirst()).allSatisfy { $0 > $1 })
        #expect(detail.int("withinPageDupes") == 0)
        #expect(detail.bool("overlapConsistent"))
        #expect(detail.bool("prependedAreOlder"))
        #expect(detail.bool("reachedStart"))
    }

    @Test func theLiveTailStaysUnchangedWhilePagingHistory() throws {
        let harness = try HistoryHarness()
        let result = try harness.run("transcriptHistoryLiveTail", snapshot: "live-tail")
        #expect(result.ok, "JS error: \(result.errorText)")
        #expect(result.detail.bool("tailSame"))
        #expect(result.detail.strings("tailBefore") == result.detail.strings("tailAfter"))
        #expect(result.detail.int("lenBefore") == result.detail.int("lenAfter"))
    }

    @Test func theHistoryWindowStaysBounded() throws {
        let harness = try HistoryHarness()
        let result = try harness.run("transcriptHistoryWindowBound", snapshot: "window-bound")
        #expect(result.ok, "JS error: \(result.errorText)")
        #expect(result.detail.bool("reachedStart"))
        #expect(result.detail.int("maxItems") <= 2200)
    }

    @Test func aCancelledOlderReadRetriesWithAFreshFetch() throws {
        let harness = try HistoryHarness()
        let result = try harness.run("transcriptHistoryCancelRetry", snapshot: "cancel-retry")
        #expect(result.ok, "JS error: \(result.errorText)")
        #expect(result.detail.bool("held"))
        #expect(result.detail.bool("cancelled"))
        #expect(result.detail.bool("retriedActive"))
        #expect(result.detail.int("retriedItems") > 0)
    }
}

private struct HistoryResult {
    let ok: Bool
    let detail: HistoryDetail
    var errorText: String { detail.values["error"] as? String ?? "" }
}

private struct HistoryDetail {
    let values: [String: Any]
    func int(_ key: String) -> Int { (values[key] as? NSNumber)?.intValue ?? -1 }
    func bool(_ key: String) -> Bool { (values[key] as? NSNumber)?.boolValue ?? false }
    func numbers(_ key: String) -> [Double] {
        (values[key] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.doubleValue }
    }
    func strings(_ key: String) -> [String] { values[key] as? [String] ?? [] }
}

/// Real JavaScriptCore with the harness virtual scheduler; no daemon, sleeps or shipping hooks.
@MainActor private final class HistoryHarness {
    let context: JSContext
    init() throws {
        context = try #require(JSContext())
        context.setObject(NativeBytes.functions(), forKeyedSubscript: "nativeBytes" as NSString)
        context.setObject(nativeHead, forKeyedSubscript: "nativeHead" as NSString)
        context.setObject(nativeTail, forKeyedSubscript: "nativeTail" as NSString)
        context.setObject(nativeEmit, forKeyedSubscript: "nativeEmit" as NSString)
        context.setObject(nativeEncode, forKeyedSubscript: "nativeEncode" as NSString)
        let parseURL: @convention(block) (String) -> String = { text in
            guard let parsed = ParsedURL.parse(text), let data = try? JSONEncoder().encode(parsed) else { return "" }
            return String(decoding: data, as: UTF8.self)
        }
        context.setObject(parseURL, forKeyedSubscript: "nativeParseURL" as NSString)
        context.evaluateScript("""
          let time = 0, nextID = 0;
          const timers = new Map();
          globalThis.aceHost = {
            now: () => time, uuid: () => String(++nextID),
            timer: (id, delay, run) => timers.set(id, {at: time + delay, run}),
            cancelTimer: id => timers.delete(id), emit: nativeEmit, utf8Base64: nativeEncode, encode: nativeBytes.encode, decode: nativeBytes.decode, inflate: nativeBytes.inflate,
            previewHead: nativeHead, previewTail: nativeTail, parseURL: nativeParseURL
          };
          function advance() {
            const pending = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
            if (!pending) return;
            timers.delete(pending[0]); time = pending[1].at; pending[1].run();
          }
          """)
        let url = try #require(Bundle(for: HistoryBundle.self).url(forResource: "bridge-tests", withExtension: "js"))
        context.evaluateScript(try String(contentsOf: url, encoding: .utf8))
        try #require(context.exception == nil)
    }

    func run(_ function: String, snapshot name: String) throws -> HistoryResult {
        context.objectForKeyedSubscript(function)?.call(withArguments: [])
        try #require(context.exception == nil)
        for _ in 0..<1000 {
            if let result = settledSnapshot(name) { return result }
            context.evaluateScript("0")
            try #require(context.exception == nil)
        }
        throw HistoryTimeout(function: function)
    }

    func settledSnapshot(_ name: String) -> HistoryResult? {
        guard let json = context.evaluateScript("transcriptHistorySnapshot('\(name)')")?.toString(),
              let data = json.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              ((root["settled"] as? NSNumber)?.boolValue ?? false)
        else { return nil }
        return HistoryResult(
            ok: (root["ok"] as? NSNumber)?.boolValue ?? false,
            detail: HistoryDetail(values: root["detail"] as? [String: Any] ?? [:]))
    }

    var nativeEmit: @convention(block) (String) -> Void { { _ in } }
    var nativeEncode: @convention(block) (String) -> String { { Data($0.utf8).base64EncodedString() } }
    var nativeHead: @convention(block) (String, Int) -> String {
        { DisplayText.head($0, limit: $1) }
    }
    var nativeTail: @convention(block) (String, Int) -> String {
        { DisplayText.tail($0, limit: $1) }
    }
}

private struct HistoryTimeout: Error {
    let function: String
}

private final class HistoryBundle: NSObject {}
