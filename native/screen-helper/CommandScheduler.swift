import Foundation

/// Independent target lanes may await concurrently. Foreground HID and clipboard share one lane.
@MainActor final class CommandScheduler {
    private var tails: [String: Task<Void, Never>] = [:]
    private var global: Task<Void, Never>?
    private var serial: UInt64 = 0
    private var revisions: [String: UInt64] = [:]
    private(set) var pending = 0
    func submit(key: String, coordinated: Bool, operation: @escaping @MainActor () async -> Void) -> Bool {
        guard pending < 32 else { return false }
        pending += 1; serial += 1
        let revision = serial, previous = tails[key], predecessor = coordinated ? global : nil
        revisions[key] = revision
        let task = Task { @MainActor in
            await previous?.value
            await predecessor?.value
            await operation()
            self.pending -= 1
            if self.revisions[key] == revision { self.tails.removeValue(forKey: key); self.revisions.removeValue(forKey: key) }
        }
        tails[key] = task
        if coordinated { global = task }
        return true
    }
    func drain() async {
        let tasks = Array(tails.values)
        for task in tasks { await task.value }
    }
}
