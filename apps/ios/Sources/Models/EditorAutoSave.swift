import Foundation

/// When the editor writes a dirty file by itself (Settings › Editor): off, or once typing has
/// rested for the delay. A write that met a file someone else changed, or failed, waits for the
/// person's own Save. Pure: the file screen owns the timer and asks this when a keystroke lands
/// and when the timer fires.
struct EditorAutoSave: Equatable {
    var mode: EditorAutoSaveMode
    /// Milliseconds typing must rest.
    var delay: Int
    /// Set once an automatic write met another change or could not be made: nothing else is
    /// written until the person saves by hand.
    private(set) var stopped = false

    init(mode: EditorAutoSaveMode = .off, delay: Int = 1000, stopped: Bool = false) {
        self.mode = mode
        self.delay = max(0, delay)
        self.stopped = stopped
    }

    /// The person typed at `now` (milliseconds): when the write falls due, or nil when none will.
    func typed(at now: Int) -> Int? {
        guard mode == .pause, !stopped, delay > 0 else { return nil }
        return now + delay
    }

    /// A write met a file someone else changed, or failed.
    mutating func failed() {
        stopped = true
    }

    /// The person saved the file themselves: automatic writes may resume.
    mutating func savedByHand() {
        stopped = false
    }
}
