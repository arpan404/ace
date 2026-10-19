import Foundation

/// Called by long-running work (between steps, inside typing, key repeats and waits) to stop
/// as soon as the request should stop: it throws `cancelled`, `stopped_by_person`,
/// `person_active` or `screen_locked`.
struct CUCheckpoint {
    let check: () throws -> Void
    static let none = CUCheckpoint(check: {})
}

/// Requests that are queued or running, and which of them the client cancelled. Used from the
/// stdin thread (cancel is answered immediately, outside the serial queue) and the main thread.
final class CUCancellations: @unchecked Sendable {
    private let lock = NSLock()
    private var flags: [String: Bool] = [:]

    func register(_ id: String) { lock.withLock { flags[id] = false } }
    func finish(_ id: String) { lock.withLock { _ = flags.removeValue(forKey: id) } }

    /// Marks a queued or running request cancelled. False when no such request is in flight.
    func cancel(_ id: String) -> Bool {
        lock.withLock {
            guard flags[id] != nil else { return false }
            flags[id] = true
            return true
        }
    }

    func isCancelled(_ id: String) -> Bool { lock.withLock { flags[id] == true } }
}

/// The person's Esc: it counts only while a batch of actions runs, and every batch starts
/// clean so an earlier Esc never stops a later, unrelated request.
final class CUStopSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var acting = false
    private var pressed = false

    func begin() { lock.withLock { acting = true; pressed = false } }
    func end() { lock.withLock { acting = false; pressed = false } }
    func escapePressed() { lock.withLock { if acting { pressed = true } } }
    var stopRequested: Bool { lock.withLock { pressed } }
}

/// Reads the system facts behind `cuGuard` at most every `intervalNs`, so loops can check
/// every few milliseconds without paying for session and HID queries each time.
struct CUThrottle {
    let intervalNs: UInt64
    private var last: UInt64?

    init(intervalNs: UInt64) { self.intervalNs = intervalNs }

    mutating func due(now: UInt64) -> Bool {
        if let last, now >= last, now - last < intervalNs { return false }
        last = now
        return true
    }
}

let cuCancelledMessage = "Stopped: the agent's turn was cancelled."
