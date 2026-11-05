import Foundation
import JavaScriptCore
import Testing
@testable import Ace

/// Host replies are answered on native queues; debug builds stop at any JavaScriptCore use there.
@Suite struct VMThreadTests {
    private static let calls = 500
    /// Asks the host for an operation it doesn't have: the storage queue answers each `unsupported`.
    private static let ask = """
    globalThis.replies = 0;
    for (let i = 0; i < \(calls); i++) {
      aceHost.call("test.unknown", "null", undefined, (error) => { if (error === "unsupported") replies++; });
    }
    """

    @Test func repliesAnsweredOnTheStorageQueueAllReachJavaScriptOnTheVMThread() async throws {
        let runtime = ClientRuntime.warm()
        runtime.execute { context in context.evaluateScript(Self.ask) }
        var replies = 0
        for _ in 0..<500 where replies < Self.calls {
            replies = await read("replies", from: runtime)
            if replies < Self.calls { try await Task.sleep(for: .milliseconds(10)) }
        }
        #expect(replies == Self.calls)
        await withCheckedContinuation { done in runtime.stop { done.resume() } }
    }

    @Test func stoppingWithRepliesInFlightFinishesWithoutTouchingTheStoppedVM() async {
        let runtime = ClientRuntime.warm()
        runtime.execute { context in context.evaluateScript(Self.ask) }
        await withCheckedContinuation { done in runtime.stop { done.resume() } }
        // Replies still queued on the storage queue now find no VM; they must be dropped quietly.
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await read("replies", from: runtime) == -1)
    }

    /// A global's number from the VM thread, or -1 once the runtime has stopped.
    private func read(_ name: String, from runtime: ClientRuntime) async -> Int {
        await withCheckedContinuation { (done: CheckedContinuation<Int, Never>) in
            let once = Once(done)
            runtime.execute { context in once.resume(Int(context.objectForKeyedSubscript(name)?.toInt32() ?? 0)) }
            // A stopped runtime drops the work; answer -1 instead of waiting forever.
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) { once.resume(-1) }
        }
    }
}

private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Int, Never>?
    init(_ continuation: CheckedContinuation<Int, Never>) { self.continuation = continuation }
    func resume(_ value: Int) {
        let pending = lock.withLock { () -> CheckedContinuation<Int, Never>? in defer { continuation = nil }; return continuation }
        pending?.resume(returning: value)
    }
}
