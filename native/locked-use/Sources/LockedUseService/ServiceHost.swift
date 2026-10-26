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
///
/// The spawning daemon writes its token line to stdin first and keeps stdin open. Only a
/// connection from that same daemon process (the kernel-attested peer must be this
/// process's parent) that completes the challenge handshake is served; the token itself
/// never crosses the socket. EOF on stdin, SIGTERM, SIGINT or SIGHUP stop any attempt,
/// request relock, and exit once the lock is confirmed.
@MainActor public enum LockedUseServiceHost {
    public static func run(arguments: [String]) -> Never {
        guard let index = arguments.firstIndex(of: "--socket"), index + 1 < arguments.count else {
            fail("usage: --locked-use --socket <path>", code: 2)
        }
        let path = arguments[index + 1]
        guard let token = lockedUseReadDaemonToken(fd: STDIN_FILENO, timeoutMilliseconds: 5_000) else {
            fail("no daemon token on stdin: expected 64 lowercase hex characters and a newline", code: 2)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let now: () -> UInt64 = { clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) }
        let team = try? lockedUseOwnTeam()
        if team == nil { log("unsigned build: installation can never verify, so locked use stays unavailable") }

        let guardian = LockedUseGuardianClient(connect: { privileged(LockedUseNames.guardianService, peer: LockedUseNames.guardianIdentifier, team: team) }, now: now)
        let monitor = LockedUseInstallationMonitor(queue: DispatchQueue(label: "dev.ace.locked-use.probe", qos: .utility)) {
            probe(team: team)
        }
        let links = Links()
        let events = EventRelay()
        let observer = LockedUseSessionObserver(read: lockedUseReadQuartzSession)
        let installation: () -> LockedUseInstallationFacts = {
            var facts = monitor.facts
            facts.brokerLinked = links.broker?.linked ?? false
            facts.guardianLinked = links.guardianAnswered
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
        links.broker = LockedUseBrokerClient(connect: { privileged(LockedUseNames.brokerService, peer: LockedUseNames.authorityIdentifier, team: team) },
            coordinator: service.coordinator)
        var listener: LockedUseSocketServer?
        let server = LockedUseSocketServer(path: path, queue: queue) { fd in
            // Nothing is served, and no state is sent, until the daemon proves the token.
            LockedUseDaemonLink(fd: fd, queue: queue, token: token, onAuthenticated: { outbox.connection = $0 },
                onRequest: { frame in
                    DispatchQueue.main.async { MainActor.assumeIsolated { service.handle(frame) } }
                }, onClose: { authenticated in
                    outbox.connection = nil
                    listener?.connectionClosed()
                    guard authenticated else { return }
                    DispatchQueue.main.async { MainActor.assumeIsolated { service.daemonDisconnected() } }
                })
        }
        listener = server
        do { try server.start() } catch { fail("cannot listen on \(path): \(error)", code: 1) }

        // Slow checks run once now and again every few seconds. None of them waits on the
        // main thread: probes run on their own queue and XPC replies arrive asynchronously.
        let refresh = {
            monitor.refresh()
            guardian.ping { links.guardianAnswered = $0 }
            if links.broker?.linked != true { links.broker?.register() }
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
        let lifecycle = LockedUseServiceLifecycle(service: service, server: server, now: now, log: log)
        lifecycle.watch()
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

    static func log(_ message: String) {
        FileHandle.standardError.write(Data("locked-use: \(message)\n".utf8))
    }

    private static func fail(_ message: String, code: Int32) -> Never {
        log(message)
        exit(code)
    }
}

/// Read-only installation probes; runs on the monitor's queue. Unsigned builds never verify.
private func probe(team: String?) -> LockedUseInstallationFacts {
    guard let team else { return LockedUseInstallationFacts() }
    return LockedUseInstallationFacts(pluginSigned: LockedUseInstallationProbe.pluginSigned(team: team),
        ruleReachesMechanism: LockedUseInstallationProbe.ruleReachesMechanism(),
        lockOnDisplaySleep: LockedUseInstallationProbe.lockOnDisplaySleep())
}

/// Link facts filled in by asynchronous replies on the main actor.
@MainActor private final class Links {
    var broker: LockedUseBrokerClient?
    var guardianAnswered = false
}

@MainActor private final class EventRelay {
    weak var service: LockedUseService?
    func forward(_ event: LockedUseDriverEvent) { service?.driverEvent(event) }
}

private final class Outbox: @unchecked Sendable {
    private let lock = NSLock()
    private var current: LockedUseDaemonLink?
    var connection: LockedUseDaemonLink? {
        get { lock.lock(); defer { lock.unlock() }; return current }
        set { lock.lock(); current = newValue; lock.unlock() }
    }
}
