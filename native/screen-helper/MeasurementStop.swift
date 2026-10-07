import Foundation
import ScreenCaptureKit
import Darwin

/// A shared stop acknowledgement prevents watchdog and normal cleanup from racing SCK.
/// Detached stopping remains available while the main actor is inside a synchronous AX call.
final class MeasurementStop: @unchecked Sendable {
    private let stopCapture: @Sendable () async throws -> Void
    private let failed: @Sendable (Error) -> Void
    private let lock = NSLock()
    private var stopping: Task<Void, Error>?
    private var watchdog: DispatchWorkItem?
    private var expired = false
    init(stopCapture: @escaping @Sendable () async throws -> Void, failed: @escaping @Sendable (Error) -> Void) {
        self.stopCapture = stopCapture; self.failed = failed
    }
    convenience init(stream: SCStream) {
        self.init(stopCapture: { try await stream.stopCapture() }, failed: { _ in
            // Stream deallocation is not an acknowledgement. Process cleanup is the fallback.
            FileHandle.standardError.write(Data("screen-helper: measurement capture stop was not acknowledged; terminating helper\n".utf8))
            exit(1)
        })
    }
    var deadlineReached: Bool { lock.withLock { expired } }
    private func stopTask() -> Task<Void, Error> {
        lock.withLock {
            if let stopping { return stopping }
            let stopCapture = self.stopCapture, failed = self.failed
            let task = Task.detached {
                do { try await stopCapture() }
                catch { failed(error); throw error }
            }
            stopping = task
            return task
        }
    }
    func stop() async throws { try await stopTask().value }
    func arm(afterMs: Double, onDeadline: @escaping () -> Void) {
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.withLock { self.expired = true }
            _ = self.stopTask()
            onDeadline()
        }
        watchdog = item
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + max(0, afterMs) / 1000, execute: item)
    }
    func cancelWatchdog() { watchdog?.cancel(); watchdog = nil }
}
