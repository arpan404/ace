import Foundation
import Darwin
import LockedUseTransport

/// Graceful termination for the service process. SIGTERM, SIGINT, SIGHUP or EOF on stdin
/// (the spawning daemon is gone) stops accepting connections, stops any attempt's work and
/// requests relock, then exits once the OS confirms the lock or `grace` has passed.
///
/// The independent guardian stays the backstop: if this process exits before the confirmed
/// lock, or is killed without running any of this, the guardian sees the owner exit or the
/// link drop and relocks on its own.
@MainActor final class LockedUseServiceLifecycle {
    static let grace: UInt64 = 5_000_000_000

    private let service: LockedUseService
    private let server: LockedUseSocketServer
    private let now: () -> UInt64
    private let log: (String) -> Void
    private var sources: [DispatchSourceProtocol] = []
    private var stopping = false

    init(service: LockedUseService, server: LockedUseSocketServer, now: @escaping () -> UInt64, log: @escaping (String) -> Void) {
        self.service = service
        self.server = server
        self.now = now
        self.log = log
    }

    func watch() {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.terminate("signal \(number)") } }
            source.resume()
            sources.append(source)
        }
        let input = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        input.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                var buffer = [UInt8](repeating: 0, count: 256)
                let count = read(STDIN_FILENO, &buffer, buffer.count)
                if count < 0, errno == EINTR || errno == EAGAIN { return }
                // Anything the daemon writes after the token is ignored; only EOF matters.
                guard count <= 0 else { return }
                input.cancel()
                self?.terminate("the daemon closed stdin")
            }
        }
        input.resume()
        sources.append(input)
    }

    private func terminate(_ why: String) {
        guard !stopping else { return }
        stopping = true
        log("stopping (\(why)): ending any attempt and requesting relock")
        server.stop()
        service.shutdown()
        let started = now()
        let check = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let waited = self.now() &- started
                guard self.service.settled || waited >= Self.grace else { return }
                if !self.service.settled { self.log("relock not confirmed in time; the guardian relocks after exit") }
                exit(0)
            }
        }
        RunLoop.main.add(check, forMode: .common)
    }
}
