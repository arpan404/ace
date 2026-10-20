import Foundation

/// One open live view's acknowledgements, sent from the renderer's queue as each chunk is
/// decoded. While the app isn't visible they are owed: only the newest is kept (still asking for
/// a keyframe if any did), so the daemon's window fills and it sends nothing more until the view
/// is seen again, as the web does when hidden. Once closed nothing more is sent, so decodes a
/// closed view still finishes never acknowledge into the next one. Sends happen under the lock,
/// so they leave in order. Thread-safe.
final class BrowserAcks: @unchecked Sendable {
    private let lock = NSLock()
    private let send: @Sendable (BrowserAck) -> Void
    private var visible: Bool
    private var owed: BrowserAck?
    private var closed = false

    init(visible: Bool, send: @escaping @Sendable (BrowserAck) -> Void) {
        self.visible = visible
        self.send = send
    }
    func acknowledge(_ value: BrowserAck) {
        lock.withLock {
            guard !closed else { return }
            guard visible else {
                owed = owed.map { BrowserAck(sequence: max($0.sequence, value.sequence), keyframe: $0.keyframe || value.keyframe) } ?? value
                return
            }
            send(value)
        }
    }
    /// The app came to the foreground or left it: coming back sends what is owed.
    func setVisible(_ value: Bool) {
        lock.withLock {
            visible = value
            guard value, !closed, let held = owed else { return }
            owed = nil
            send(held)
        }
    }
    func close() {
        lock.withLock {
            closed = true
            owed = nil
        }
    }
}
