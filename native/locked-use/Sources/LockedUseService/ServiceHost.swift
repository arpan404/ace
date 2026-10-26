import AppKit
import Darwin
import LockedUseCore
import LockedUseRuntime
import LockedUseSession
import LockedUseSystem
import LockedUseTransport

/// Production wiring for `ace-screen-helper --locked-use --socket <path>`: the coordinator,
/// the native covers and input guard, the system session driver, and links to the root
/// authority broker and the independent guardian. Installs nothing and changes no policy;
/// without a verified installation every begin request is refused.
@MainActor public enum LockedUseServiceHost {
    public static func run(arguments: [String]) -> Never {
        guard let index = arguments.firstIndex(of: "--socket"), index + 1 < arguments.count else {
            fail("usage: --locked-use --socket <path>", code: 2)
        }
        let path = arguments[index + 1]
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let now: () -> UInt64 = { clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) }
        let team = try? lockedUseOwnTeam()
        if team == nil { log("unsigned build: installation can never verify, so locked use stays unavailable") }

        let guardian = LockedUseGuardianClient(connect: { privileged(LockedUseNames.guardianService, peer: LockedUseNames.guardianIdentifier, team: team) }, now: now)
        var probe = Probe(team: team)
        var broker: LockedUseBrokerClient?
        let events = EventRelay()
        let observer = LockedUseSessionObserver(read: lockedUseReadQuartzSession)
        let installation: () -> LockedUseInstallationFacts = {
            var facts = probe.facts
            facts.brokerLinked = broker?.linked ?? false
            facts.guardianLinked = probe.guardianAnswered
            return facts
        }
        let driver = LockedUseSystemSessionDriver(readSession: lockedUseReadQuartzSession, installation: installation,
            unlock: LockedUseAuthorizationServicesUnlock(), lock: LockedUseDisplaySleepLock(), now: now,
            events: { events.forward($0) })
        let ports = LockedUseServicePorts(driver: driver, guardian: guardian, observer: observer, installation: installation,
            makeDesktop: { agents, takeover, lost in
                LockedUseNativeDesktop(agentProcessIDs: agents, verifyOrdering: lockedUseVerifyCoverOrdering,
                    takeover: takeover, protectionLost: lost)
            }, now: now, schedule: every50ms)

        let queue = DispatchQueue(label: "dev.ace.locked-use.daemon-link")
        let outbox = Outbox()
        let service = LockedUseService(ports: ports) { message in
            guard let data = try? message.encoded() else { return }
            outbox.connection?.send(data)
        }
        events.service = service
        broker = LockedUseBrokerClient(connect: { privileged(LockedUseNames.brokerService, peer: LockedUseNames.authorityIdentifier, team: team) },
            coordinator: service.coordinator)
        var listener: LockedUseSocketServer?
        let server = LockedUseSocketServer(path: path, queue: queue) { fd in
            let connection = LockedUseFramedConnection(fd: fd, queue: queue, onFrame: { frame in
                DispatchQueue.main.async { MainActor.assumeIsolated { service.handle(frame) } }
            }, onClose: {
                outbox.connection = nil
                listener?.connectionClosed()
                DispatchQueue.main.async { MainActor.assumeIsolated { service.daemonDisconnected() } }
            })
            outbox.connection = connection
            return connection
        }
        listener = server
        do { try server.start() } catch { fail("cannot listen on \(path): \(error)", code: 1) }

        // Slow checks run once now and again every few seconds, never on the heartbeat path.
        let refresh = {
            probe.refresh()
            probe.guardianAnswered = guardian.ping()
            if broker?.linked != true { broker?.register() }
        }
        refresh()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in MainActor.assumeIsolated { refresh() } }
        // Lock notifications are only wake-ups; the session is always re-read.
        let center = DistributedNotificationCenter.default()
        for name in ["com.apple.screenIsLocked", "com.apple.screenIsUnlocked"] {
            center.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { observer.poll() }
            }
        }
        service.start()
        app.run()
        exit(0)
    }

    private static func every50ms(_ body: @escaping @MainActor () -> Void) -> () -> Void {
        let timer = Timer(timeInterval: 0.05, repeats: true) { _ in MainActor.assumeIsolated { body() } }
        RunLoop.main.add(timer, forMode: .common)
        return { timer.invalidate() }
    }

    /// A privileged Mach-service connection whose peer must carry ace's team signature.
    /// Without a team the requirement cannot be satisfied and the link fails closed.
    private static func privileged(_ service: String, peer: String, team: String?) -> NSXPCConnection {
        let connection = NSXPCConnection(machServiceName: service, options: .privileged)
        let requirement = team.flatMap { try? lockedUsePeerRequirement(identifier: peer, team: $0) }
        connection.setCodeSigningRequirement(requirement ?? "never")
        return connection
    }

    private static func log(_ message: String) {
        FileHandle.standardError.write(Data("locked-use: \(message)\n".utf8))
    }

    private static func fail(_ message: String, code: Int32) -> Never {
        log(message)
        exit(code)
    }
}

/// Cached read-only installation probes.
private struct Probe {
    let team: String?
    var facts = LockedUseInstallationFacts()
    var guardianAnswered = false

    init(team: String?) { self.team = team }

    mutating func refresh() {
        guard let team else { facts = LockedUseInstallationFacts(); return }
        facts.pluginSigned = LockedUseInstallationProbe.pluginSigned(team: team)
        facts.ruleReachesMechanism = LockedUseInstallationProbe.ruleReachesMechanism()
        facts.lockOnDisplaySleep = LockedUseInstallationProbe.lockOnDisplaySleep()
    }
}

@MainActor private final class EventRelay {
    weak var service: LockedUseService?
    func forward(_ event: LockedUseDriverEvent) { service?.driverEvent(event) }
}

private final class Outbox: @unchecked Sendable {
    private let lock = NSLock()
    private var current: LockedUseFramedConnection?
    var connection: LockedUseFramedConnection? {
        get { lock.lock(); defer { lock.unlock() }; return current }
        set { lock.lock(); current = newValue; lock.unlock() }
    }
}
