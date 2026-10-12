import Foundation
import JavaScriptCore
import Testing
@testable import Ace

@Suite @MainActor struct PatchPumpTests {
    @Test func aSurrogateBoundaryTitleAndLaterCanonicalStatusBothArrive() throws {
        let harness = try DeliveryHarness()
        harness.call("queueUnicode")
        harness.call("queueMalformedDisplay")
        try harness.step()
        harness.call("queueStatus")
        for _ in 0..<4 { try harness.step() }
        #expect(harness.model.thread?.items["unicode"]?.row.text == String(repeating: "x", count: 8191))
        #expect(harness.model.inbox["status"]?.state == "working")
        #expect(harness.model.thread?.items["malformed"]?.row.text == "�a")
        #expect(harness.rejected == 0)
    }
    @Test func continuousLargeContentCannotStarveAPendingApprovalOrWorkingStatus() throws {
        let harness = try DeliveryHarness()
        harness.call("updateLarge")
        try harness.step() // Begin the existing content transfer before critical updates arrive.
        harness.call("queueSibling")
        harness.call("queueApproval")
        harness.call("queueStatus")
        for _ in 0..<16 {
            harness.call("updateLarge")
            try harness.step()
        }
        let approval = try #require(harness.model.thread?.approvals.first)
        #expect(approval.options.first?.id == "action-" + String(repeating: "x", count: 32768))
        #expect(approval.state == "pending")
        #expect(harness.model.thread?.items["sibling"]?.row.text == "A later content row")
        #expect(harness.model.inbox["status"]?.state == "working")
        for _ in 0..<24 { try harness.step() }
        #expect(harness.model.thread?.items.values.contains { $0.row.text == "revision 17" } == true)
        #expect(harness.rejected == 0)
    }
    @Test func permanentDisplayRejectionBacksOffAndDegradesWithoutLosingActions() throws {
        let harness = try DeliveryHarness()
        harness.call("queueBrokenApproval")
        for _ in 0..<3 { try harness.step() }
        harness.call("queueStatus")
        for _ in 0..<2 { try harness.step() }
        #expect(harness.model.inbox["status"]?.state == "working")
        for _ in 0..<20 { try harness.step() }
        let approval = try #require(harness.model.thread?.approvals.first)
        #expect(approval.truncated)
        #expect(approval.state == "pending")
        #expect(approval.options.first?.id == "action-" + String(repeating: "x", count: 32768))
        #expect(approval.options.first?.kind == "allow_once")
        #expect(harness.rejected <= 3)
        #expect(!harness.hasScheduledWork)
        #expect(zip(harness.rejectionTimes, harness.rejectionTimes.dropFirst()).allSatisfy { $1 - $0 >= 32 })
    }
    @Test func aRejectedBatchIsIsolatedAndNewerBadReadersDoNotResetTheRetryBudget() throws {
        let harness = try DeliveryHarness()
        harness.call("queueBrokenContent")
        harness.call("queueStatus")
        try harness.step() // Both native rows are rejected atomically.
        for _ in 0..<16 {
            harness.call("queueBrokenContent")
            try harness.step()
        }
        #expect(harness.model.inbox["status"]?.state == "working")
        let row = try #require(harness.model.thread?.items["poison"]?.row)
        #expect(row.truncated)
        #expect(!row.complete)
        #expect(row.agentId == "agent")
        for _ in 0..<4 { try harness.step() }
        #expect(harness.rejected <= 3)
        #expect(!harness.hasScheduledWork)
    }
    @Test func anUndecodableIdentityIsRetainedWithoutBlockingOtherWorkAndCanRecover() throws {
        let harness = try DeliveryHarness()
        harness.call("queueInvalidIdentity")
        for _ in 0..<8 { try harness.step() }
        #expect(!harness.hasScheduledWork)
        #expect(harness.model.thread?.items["poison"] == nil)
        #expect(harness.model.error?.contains("Reconnect") == true)
        harness.call("queueStatus")
        try harness.step()
        #expect(harness.model.inbox["status"]?.state == "working")
        harness.call("repairIdentity")
        try harness.step()
        #expect(harness.model.thread?.items["poison"]?.row.id == "poison")
        #expect(harness.model.thread?.items["poison"]?.row.complete == false)
        #expect(!harness.hasScheduledWork)
    }
    @Test func aRejectedResetCannotEraseRowsConfirmedWhileItWasDelayed() throws {
        let harness = try DeliveryHarness()
        harness.call("queueReset")
        try harness.step(reject: true)
        harness.call("queueSibling")
        for _ in 0..<8 { try harness.step() }
        #expect(harness.model.thread?.items["sibling"]?.row.text == "A later content row")
        #expect(!harness.hasScheduledWork)
    }

}

/// Virtual time and real JavaScriptCore/JSONDecoder; no daemon, sleeps or shipping test hooks.
@MainActor private final class DeliveryHarness {
    let model = ClientModel(now: { 0 })
    let context: JSContext
    var emitted: [Data] = []
    var rejected = 0
    var rejectionTimes: [Double] = []
    var hasScheduledWork: Bool { context.evaluateScript("timers.size > 0")?.toBool() == true }
    init() throws {
        context = try #require(JSContext())
        model.open("thread")
        let emit: @convention(block) (String) -> Void = { [weak self] text in self?.emitted.append(Data(text.utf8)) }
        let encode: @convention(block) (String) -> String = { Data($0.utf8).base64EncodedString() }
        let bytes: @convention(block) (String) -> [UInt8] = { Array($0.utf8) }
        context.setObject(bytes, forKeyedSubscript: "nativeBytes" as NSString)
        let head: @convention(block) (String, Int) -> String = { DisplayText.head($0, limit: $1) }
        let tail: @convention(block) (String, Int) -> String = { DisplayText.tail($0, limit: $1) }
        context.setObject(head, forKeyedSubscript: "nativeHead" as NSString)
        context.setObject(tail, forKeyedSubscript: "nativeTail" as NSString)
        context.setObject(emit, forKeyedSubscript: "nativeEmit" as NSString)
        context.setObject(encode, forKeyedSubscript: "nativeEncode" as NSString)
        context.evaluateScript("""
          let time = 0, nextID = 0;
          const timers = new Map();
          globalThis.aceHost = {
            now: () => time, uuid: () => String(++nextID),
            timer: (id, delay, run) => timers.set(id, {at: time + delay, run}),
            cancelTimer: id => timers.delete(id), emit: nativeEmit, utf8Base64: nativeEncode, encode: nativeBytes,
            previewHead: nativeHead, previewTail: nativeTail
          };
          function advance() {
            const pending = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
            if (!pending) return;
            timers.delete(pending[0]); time = pending[1].at; pending[1].run();
          }
          """)
        let url = try #require(Bundle(for: TestBundle.self).url(forResource: "bridge-tests", withExtension: "js"))
        context.evaluateScript(try String(contentsOf: url, encoding: .utf8))
        #expect(context.exception == nil)
    }
    func call(_ function: String) { context.objectForKeyedSubscript(function)?.call(withArguments: []) }
    func step(reject: Bool = false) throws {
        call("advance")
        #expect(context.exception == nil)
        let frames = emitted; emitted.removeAll()
        for data in frames {
            let accepted = reject ? false : model.receive(data)
            if !accepted { rejected += 1; rejectionTimes.append(context.evaluateScript("time")?.toDouble() ?? 0) }
            context.objectForKeyedSubscript("acknowledge")?.call(withArguments: [accepted])
        }
    }
}
private final class TestBundle: NSObject {}
