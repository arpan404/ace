import Foundation
import LockedUseCore
import LockedUseRuntime
import LockedUseSession
import LockedUseSystem
import LockedUseTransport

/// Everything the service needs from outside; production values live in `LockedUseServiceHost`.
public struct LockedUseServicePorts {
    public typealias Pulse = (@escaping @MainActor () -> Void) -> () -> Void
    public typealias DesktopFactory = (_ agents: Set<Int32>, _ takeover: @escaping (LockedUseScope) -> Void,
                                       _ protectionLost: @escaping (LockedUseScope) -> Void) -> LockedUseDesktop
    public let driver: LockedUseSessionDriver
    public let guardian: LockedUseGuardian
    public let observer: LockedUseSessionObserver
    public let installation: () -> LockedUseInstallationFacts
    public let makeDesktop: DesktopFactory
    public let now: () -> UInt64
    /// Recurring pulse, at most 100 ms apart, for the coordinator and session polling.
    public let schedule: Pulse

    public init(driver: LockedUseSessionDriver, guardian: LockedUseGuardian, observer: LockedUseSessionObserver,
                installation: @escaping () -> LockedUseInstallationFacts, makeDesktop: @escaping DesktopFactory,
                now: @escaping () -> UInt64, schedule: @escaping Pulse) {
        self.driver = driver
        self.guardian = guardian
        self.observer = observer
        self.installation = installation
        self.makeDesktop = makeDesktop
        self.now = now
        self.schedule = schedule
    }
}

/// GUI-session host for one coordinator. It turns daemon requests into coordinator calls,
/// session observations into unlocked/locked callbacks, and reports state and completions.
/// It never reports an attempt complete before the coordinator has seen a confirmed lock.
@MainActor public final class LockedUseService {
    public let coordinator: LockedUseCoordinator
    private let ports: LockedUseServicePorts
    private let desktop = LockedUseAttemptDesktop()
    private let gate = LockedUseWorkGate()
    private let send: (LockedUseOutbound) -> Void
    private var active: LockedUseScope?
    private var lastStatus: LockedUseStatus?
    private var stopPulse: (() -> Void)?

    public init(ports: LockedUseServicePorts, send: @escaping (LockedUseOutbound) -> Void) {
        self.ports = ports
        self.send = send
        coordinator = LockedUseCoordinator(desktop: desktop, driver: ports.driver, guardian: ports.guardian,
            now: ports.now, schedule: ports.schedule)
        let observer = ports.observer
        observer.onScopeState = { [weak self] scope, state in
            guard let self, active == scope else { return }
            if state == .unlocked { coordinator.unlocked(scope) }
            if state == .locked { coordinator.locked(scope) }
        }
        observer.onManualUnlock = { [weak self] generation in self?.coordinator.manualUnlockObserved(generation: generation) }
    }

    public func start() {
        stopPulse = ports.schedule { [weak self] in self?.pulse() }
        pulse()
    }

    public func stop() {
        stopPulse?()
        stopPulse = nil
        if let active { coordinator.connectionLost(active) }
    }

    public func handle(_ frame: Data) {
        switch lockedUseDecodeInbound(frame) {
        case .command(let command): run(command)
        case .unsupported(let id, let type):
            send(.failure(id: id, LockedUseWireError(code: "unsupported", message: "Unsupported request \(type)")))
        case .malformed(let id, let reason):
            let error = LockedUseWireError(code: "malformed", message: reason)
            send(id.map { .failure(id: $0, error) } ?? .error(error, attemptID: nil))
        }
        publishIfChanged()
    }

    /// The daemon link closed. Any attempt stops and relocks; its completion is still
    /// withheld until the OS confirms the lock.
    public func daemonDisconnected() {
        guard let active else { return }
        gate.cancel(active.attemptID)
        coordinator.connectionLost(active)
        publishIfChanged()
    }

    public func driverEvent(_ event: LockedUseDriverEvent) {
        switch event {
        case .unlockRequestFailed(let attempt, let status):
            send(.error(LockedUseWireError(code: "unlock_request_failed",
                message: "The unlock request was refused (status \(status)). The Mac stays locked."), attemptID: attempt))
        case .relockRequestFailed(let attempt):
            send(.error(LockedUseWireError(code: "relock_request_failed",
                message: "The relock request failed. Covers stay up and relock is retried."), attemptID: attempt))
        }
    }

    public var status: LockedUseStatus {
        let facts = ports.observer.current
        let install = ports.installation()
        return LockedUseStatus(phase: String(describing: coordinator.phase), session: Self.name(lockedUseSessionState(facts)),
            userID: facts?.userID, sessionID: facts?.sessionID, attemptID: active?.attemptID,
            installation: .init(pluginSigned: install.pluginSigned, ruleReachesMechanism: install.ruleReachesMechanism,
                lockOnDisplaySleep: install.lockOnDisplaySleep, brokerLinked: install.brokerLinked,
                guardianLinked: install.guardianLinked, verified: install.verified))
    }

    private func pulse() {
        ports.observer.poll()
        publishIfChanged()
    }

    private func run(_ command: LockedUseCommand) {
        switch command {
        case .status(let id):
            send(.reply(id: id, status: status))
        case .enable(let id):
            do { try coordinator.enable(); send(.reply(id: id, status: status)) }
            catch { fail(id, error) }
        case .disable(let id):
            coordinator.disable()
            send(.reply(id: id, status: status))
        case .begin(let id, let scope, let agents):
            begin(id, scope, agents)
        case .finish(let id, let attempt):
            guard active?.attemptID == attempt, gate.finish(attempt) else { return unknown(id) }
            send(.reply(id: id, status: status))
        case .cancel(let id, let attempt):
            guard let active, active.attemptID == attempt else { return unknown(id) }
            gate.cancel(attempt)
            coordinator.cancel(active)
            send(.reply(id: id, status: status))
        }
    }

    private func begin(_ id: String, _ scope: LockedUseScope, _ agents: Set<Int32>) {
        guard active == nil else { return fail(id, LockedUseRuntimeError.busy) }
        desktop.current = ports.makeDesktop(agents, { [weak self] scope in
            guard let self else { return }
            coordinator.localInput(scope, manualUnlockGeneration: ports.observer.manualUnlockGeneration)
        }, { [weak self] scope in self?.coordinator.protectionLost(scope) })
        active = scope
        ports.observer.watch(scope)
        do {
            try coordinator.begin(scope, work: gate.work(for: scope.attemptID)) { [weak self] completion in
                self?.complete(completion)
            }
            send(.reply(id: id, status: status))
        } catch {
            active = nil
            ports.observer.watch(nil)
            gate.cancel(scope.attemptID)
            fail(id, error)
        }
    }

    private func complete(_ completion: LockedUseCompletion) {
        let scope = completion.scope
        guard active == scope else { return }
        active = nil
        ports.observer.watch(nil)
        send(.completion(attemptID: scope.attemptID, threadID: scope.threadID, turnID: scope.turnID,
            reason: completion.reason.rawValue, workError: completion.workError.map { String(describing: $0) }))
        publishIfChanged()
    }

    private func publishIfChanged() {
        let current = status
        guard current != lastStatus else { return }
        lastStatus = current
        send(.state(current))
    }

    private func unknown(_ id: String) {
        send(.failure(id: id, LockedUseWireError(code: "unknown_attempt", message: "No active attempt has that id")))
    }

    private func fail(_ id: String, _ error: Error) {
        send(.failure(id: id, Self.wire(error)))
    }

    static func wire(_ error: Error) -> LockedUseWireError {
        switch error {
        case LockedUseRuntimeError.driverUnavailable:
            return LockedUseWireError(code: "not_installed", message: "Locked use is not installed and verified on this Mac.")
        case LockedUseRuntimeError.busy:
            return LockedUseWireError(code: "busy", message: "Another locked-use attempt is still active or relocking.")
        case LockedUseRuntimeError.notLocked:
            return LockedUseWireError(code: "not_locked", message: "The Mac is not locked in the approved session.")
        case LockedUseError.takeoverPending:
            return LockedUseWireError(code: "manual_unlock_required", message: "Someone used this Mac. Unlock it by hand once before locked use resumes.")
        case LockedUseError.notReady:
            return LockedUseWireError(code: "not_enabled", message: "Locked use is not enabled.")
        case LockedUseError.staleAttempt:
            return LockedUseWireError(code: "stale_attempt", message: "That attempt id was already used.")
        default:
            return LockedUseWireError(code: "failed", message: String(describing: error))
        }
    }

    private static func name(_ state: LockedUseSessionState) -> String {
        switch state {
        case .locked: return "locked"
        case .unlocked: return "unlocked"
        case .unavailable: return "unavailable"
        }
    }
}
