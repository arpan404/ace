import Foundation
import Testing
@testable import Ace

/// How launch warms machine runtimes: one parse at a time, never competing with the first frame.
@Suite @MainActor struct RuntimeWarmupTests {
    private final class Session: ClientSession, @unchecked Sendable {
        func start(itemLimit: Int) {}
        func invoke(_ name: String, json: String) {}
        func acknowledge(accepted: Bool) {}
        func stop(completion: @escaping @Sendable () -> Void) { completion() }
    }
    private final class Runtime: WarmRuntime {
        let priority: QualityOfService
        let evaluated: @Sendable () -> Void
        var adopted: String?
        var stopped = false
        init(_ priority: QualityOfService, _ evaluated: @escaping @Sendable () -> Void) { self.priority = priority; self.evaluated = evaluated }
        func adopt(target: ConnectionTarget, storageURL: URL, receive: @escaping @Sendable (Data) -> Void,
                   fail: @escaping @Sendable (String) -> Void) -> any ClientSession {
            adopted = target.hostId
            return Session()
        }
        func stop(completion: @escaping @Sendable () -> Void) { stopped = true; completion() }
    }
    private final class Made {
        var all: [Runtime] = []
    }
    private func warmup() -> (RuntimeWarmup, Made) {
        let made = Made()
        return (RuntimeWarmup { priority, evaluated in
            let runtime = Runtime(priority, evaluated)
            made.all.append(runtime)
            return runtime
        }, made)
    }
    private func target(_ host: String) -> ConnectionTarget {
        ConnectionTarget(endpoint: URL(string: "ws://127.0.0.1:1")!, hostId: host, deviceId: "device", pin: nil, credential: { "{}" })
    }
    private func connect(_ warmup: RuntimeWarmup, _ host: String) {
        _ = warmup.makeRuntime(target(host), URL(fileURLWithPath: "/dev/null"), { _ in }, { _ in })
    }
    /// Lets the main-actor hop after an evaluation run.
    private func settle() async { for _ in 0..<5 { await Task.yield() } }

    @Test func launchParsesOneBundleAtATimeAndTheRestBelowTheFirstFrame() async {
        let (warmup, made) = warmup()
        warmup.prepare(3)
        #expect(made.all.map(\.priority) == [.userInitiated], "only the first machine's runtime parses at launch")
        made.all[0].evaluated()
        await settle()
        #expect(made.all.map(\.priority) == [.userInitiated, .utility])
        made.all[1].evaluated()
        await settle()
        made.all[2].evaluated()
        await settle()
        #expect(made.all.count == 3, "never more than the phone remembers")
    }
    @Test func theFirstMachineToConnectTakesTheFirstWarmRuntime() async {
        let (warmup, made) = warmup()
        warmup.prepare(2)
        made.all[0].evaluated()
        await settle()
        connect(warmup, "studio")
        connect(warmup, "laptop")
        #expect(made.all.map(\.adopted) == ["studio", "laptop"])
    }
    @Test func aMachineConnectingBeforeItsRuntimeIsWarmGetsOneAtOnceAtFullPriority() async {
        let (warmup, made) = warmup()
        warmup.prepare(3)
        connect(warmup, "studio")
        connect(warmup, "laptop")
        #expect(made.all.map(\.adopted) == ["studio", "laptop"])
        #expect(made.all.map(\.priority) == [.userInitiated, .userInitiated])
        made.all[0].evaluated()
        made.all[1].evaluated()
        await settle()
        #expect(made.all.count == 3, "the third still warms, once, after the first two evaluated")
    }
    @Test func runtimesNoMachineTookStopAndNoMoreWarm() async {
        let (warmup, made) = warmup()
        warmup.prepare(3)
        connect(warmup, "studio")
        warmup.releaseUnused()
        made.all[0].evaluated()
        await settle()
        #expect(made.all.count == 1)
        #expect(made.all.allSatisfy { $0.adopted != nil || $0.stopped })
    }
}
