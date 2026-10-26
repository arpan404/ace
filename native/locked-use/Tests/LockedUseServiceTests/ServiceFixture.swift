import Foundation
import Security
import LockedUseCore
import LockedUseGuardianKit
import LockedUseIPC
import LockedUseRuntime
import LockedUseService
import LockedUseSession
import LockedUseSystem
import LockedUseTransport

final class Sink: LockedUseLockSink, @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    func requestLock() throws { lock.lock(); value += 1; lock.unlock() }
}

final class NoUnlock: LockedUseUnlockRequesting, @unchecked Sendable {
    var attempts: [String] = []
    func requestUnlock(attempt: String, completion: @escaping @Sendable (OSStatus) -> Void) { attempts.append(attempt) }
}

@MainActor final class CoverDesktop: LockedUseDesktop {
    let topology = try! LockedUseDisplays(ids: [1, 2], generation: 1)
    var covered = false
    var takeover: ((LockedUseScope) -> Void)?
    var agents: Set<Int32> = []
    func displays() throws -> LockedUseDisplays { topology }
    func prepare(_ scope: LockedUseScope) throws { covered = true }
    func protection() throws -> LockedUseProtection {
        LockedUseProtection(displays: topology, inputGuardReady: covered, relockGuardReady: true)
    }
    func showWorking() {}
    func showRelocking() {}
    func removeAfterConfirmedLock() { covered = false }
}

/// The real service, production session driver and real guardian client, talking over an
/// in-process XPC link to a real guardian server. OS lock, unlock and session facts are
/// substitutes; nothing here changes the Mac's lock state or opens a window.
@MainActor final class ServiceFixture {
    var facts: LockedUseSessionFacts? = ServiceFixture.facts(locked: true)
    var installed = true
    var time: UInt64 = 1_000_000_000
    var sent: [LockedUseOutbound] = []
    var pulses: [@MainActor () -> Void] = []
    let unlock = NoUnlock()
    let driverLock = Sink()
    let guardianLock = Sink()
    let relockQueue = DispatchQueue(label: "relock")
    let desktop = CoverDesktop()
    let listener = NSXPCListener.anonymous()
    nonisolated let clock = NSLock()
    nonisolated(unsafe) var guardianTime: UInt64 = 1_000_000_000
    lazy var guardianServer = LockedUseGuardianServer(listener: listener, requirement: nil, lock: guardianLock,
        now: { [unowned self] in clock.lock(); defer { clock.unlock() }; return guardianTime }, watch: { _, _, _ in {} })
    lazy var guardian = LockedUseGuardianClient(connect: { [unowned self] in NSXPCConnection(listenerEndpoint: listener.endpoint) },
        now: { [unowned self] in time })
    lazy var observer = LockedUseSessionObserver(read: { [unowned self] in facts })
    lazy var driver = LockedUseSystemSessionDriver(readSession: { [unowned self] in facts },
        installation: { [unowned self] in installation }, unlock: unlock, lock: driverLock,
        now: { [unowned self] in time }, lockQueue: relockQueue, events: { [unowned self] in service.driverEvent($0) })
    lazy var service: LockedUseService = {
        let ports = LockedUseServicePorts(driver: driver, guardian: guardian, observer: observer,
            installation: { [unowned self] in installation },
            makeDesktop: { [unowned self] agents, takeover, _ in
                desktop.takeover = takeover
                desktop.agents = agents
                return desktop
            }, now: { [unowned self] in time },
            schedule: { [unowned self] pulse in
                pulses.append(pulse)
                let index = pulses.count - 1
                return { [weak self] in self?.pulses[index] = {} }
            })
        return LockedUseService(ports: ports) { [unowned self] in sent.append($0) }
    }()

    var installation: LockedUseInstallationFacts {
        LockedUseInstallationFacts(pluginSigned: installed, ruleReachesMechanism: installed, lockOnDisplaySleep: installed,
                                   brokerLinked: installed, guardianLinked: installed)
    }

    static func facts(locked: Bool) -> LockedUseSessionFacts {
        LockedUseSessionFacts(onConsole: true, loginDone: true, screenLocked: locked ? true : nil, userID: getuid(), sessionID: 100_003)
    }

    init() {
        guardianServer.start()
        service.start()
    }

    func send(_ json: String) { service.handle(Data(json.utf8)) }

    func begin(_ attempt: String = "attempt-1") {
        send(#"{"v":1,"id":"b-\#(attempt)","type":"begin","agentProcessIDs":[4242],"scope":{"userID":\#(getuid()),"sessionID":100003,"threadID":"thread","turnID":"turn","attemptID":"\#(attempt)"}}"#)
    }

    var scope: LockedUseScope {
        try! LockedUseScope(userID: getuid(), sessionID: 100_003, threadID: "thread", turnID: "turn", attemptID: "attempt-1")
    }

    func pulse() { for pulse in pulses { pulse() } }

    nonisolated func advanceGuardian(_ nanos: UInt64) {
        clock.lock(); guardianTime += nanos; clock.unlock()
    }

    func setSession(locked: Bool) {
        facts = Self.facts(locked: locked)
        pulse()
    }

    /// Drives the plug-in path: the broker would forward exactly this query.
    func grant() -> Bool {
        service.coordinator.authorize(LockedUsePluginRequest(attempt: "attempt-1", transaction: Data(repeating: 3, count: 8),
            requestID: UUID(), deadline: time + 500_000_000))
    }

    func settle() async {
        for _ in 0..<20 {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        relockQueue.sync {}
    }

    func replies(_ id: String) -> [LockedUseOutbound] {
        sent.filter {
            switch $0 {
            case .reply(let replyID, _), .failure(let replyID, _): return replyID == id
            default: return false
            }
        }
    }

    var completions: [String] {
        sent.compactMap { if case .completion(_, _, _, let reason, _) = $0 { return reason } else { return nil } }
    }

    var phases: [String] {
        sent.compactMap { if case .state(let status) = $0 { return status.phase } else { return nil } }
    }

    func failureCode(_ id: String) -> String? {
        for message in replies(id) { if case .failure(_, let error) = message { return error.code } }
        return nil
    }
}
