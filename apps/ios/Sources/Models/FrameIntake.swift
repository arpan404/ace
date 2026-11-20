import Foundation

/// Decoded bridge frames on their way to the main thread, in the order they arrived.
///
/// The bridge sends its next frame once the last one is acknowledged (ADR 0074). Opening a thread
/// sends its window over several frames, while the main thread is busy laying out the screen being
/// pushed; acknowledging each frame only from the main thread made every one of them wait for it
/// in turn. A frame the main thread can't turn down is acknowledged as soon as it is decoded
/// instead: only a streaming text edit can be turned down there, since it is checked against the
/// text on screen. The frames still apply on the main thread, all together and in arrival order,
/// before anything that changes what they mean (opening or leaving a thread).
final class FrameIntake: @unchecked Sendable {
    struct Frame {
        let patches: [BridgePatch]?
        let bytes: Int
        /// Already acknowledged when it was decoded: applying it must not answer again.
        let answered: Bool
    }
    private let lock = NSLock()
    private var frames: [Frame] = []

    /// How a frame is answered before the main thread sees it: accepted, turned down (it could not
    /// be read), or nil when only the main thread can tell (a streaming text edit).
    nonisolated static func answer(_ patches: [BridgePatch]?) -> Bool? {
        guard let patches else { return false }
        for patch in patches { if case .itemText = patch { return nil } }
        return true
    }
    /// Queues a decoded frame; returns its answer when it can be given now.
    func push(_ patches: [BridgePatch]?, bytes: Int) -> Bool? {
        let answer = Self.answer(patches)
        lock.withLock { frames.append(Frame(patches: patches, bytes: bytes, answered: answer != nil)) }
        return answer
    }
    /// Every queued frame, oldest first; the queue starts empty again.
    func take() -> [Frame] {
        lock.withLock {
            defer { frames.removeAll(keepingCapacity: true) }
            return frames
        }
    }
}

/// The runtime a connection's frames are answered to from the decoding queue. An answer given
/// before the runtime is bound waits for it: a lost answer would leave the bridge waiting forever.
final class FrameAnswers: @unchecked Sendable {
    private let lock = NSLock()
    /// Weak: the runtime holds the closure that holds this.
    private weak var session: (any ClientSession)?
    private var bound = false
    private var waiting: [Bool] = []
    func bind(_ session: any ClientSession) {
        let answers = lock.withLock {
            self.session = session
            bound = true
            defer { waiting = [] }
            return waiting
        }
        for accepted in answers { session.acknowledge(accepted: accepted) }
    }
    func acknowledge(_ accepted: Bool) {
        let target = lock.withLock {
            if !bound { waiting.append(accepted) }
            return session
        }
        target?.acknowledge(accepted: accepted)
    }
}
