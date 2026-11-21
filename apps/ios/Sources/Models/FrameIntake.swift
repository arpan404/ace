import Foundation

/// Decoded bridge frames on their way to the main thread, in the order they arrived.
///
/// The bridge sends its next frame once the last one is acknowledged (ADR 0074), and records an
/// acknowledged frame as shown (`native-ledger.ts`). Opening a thread sends its window over
/// several frames while the main thread lays out the screen being pushed; acknowledging each one
/// only from the main thread made every one of them wait for it in turn. So a frame of the open
/// thread's own rows is acknowledged as soon as it is decoded, when it is certain to apply:
/// - every patch in it belongs to the thread and generation open now (`open`), so no epoch check
///   on the main thread can drop it. Navigation first takes every frame held here (`fence`), so
///   one acknowledged early always applies under the generation it was meant for;
/// - it carries no streaming text edit, which only the main thread can check against the text on
///   screen;
/// - the frames acknowledged early and not yet taken stay under `answeredLimit` bytes, so a busy
///   main thread can't fall behind without bound: past it, frames wait for the main thread again.
/// Everything else is acknowledged by the main thread once held. A retired runtime's intake is
/// closed: what arrives late is dropped unanswered.
final class FrameIntake: @unchecked Sendable {
    struct Frame {
        let patches: [BridgePatch]?
        let bytes: Int
        /// Already acknowledged when it was decoded: holding it must not answer again.
        let answered: Bool
    }
    /// Bytes of frames acknowledged early that the main thread has not taken yet.
    nonisolated static let answeredLimit = 1024 * 1024

    private let lock = NSLock()
    private var frames: [Frame] = []
    private var open: (thread: String, epoch: Int)?
    private var answeredBytes = 0
    private var closed = false

    /// How a frame may be answered before the main thread sees it: accepted, turned down (it
    /// could not be read), or nil when only the main thread can tell.
    nonisolated static func answer(_ patches: [BridgePatch]?, open: (thread: String, epoch: Int)?) -> Bool? {
        guard let patches else { return false }
        guard let open, !patches.isEmpty else { return nil }
        for patch in patches {
            if case .itemText = patch { return nil }
            guard let scope = patch.threadScope, scope.thread == open.thread, scope.epoch == open.epoch else { return nil }
        }
        return true
    }
    /// Queues a decoded frame; returns its answer when it can be given now. A closed intake
    /// drops it and answers nothing.
    func push(_ patches: [BridgePatch]?, bytes: Int) -> Bool? {
        lock.withLock {
            guard !closed else { return nil }
            var answer = Self.answer(patches, open: open)
            if answer == true, answeredBytes + bytes > Self.answeredLimit { answer = nil }
            if answer == true { answeredBytes += bytes }
            frames.append(Frame(patches: patches, bytes: bytes, answered: answer != nil))
            return answer
        }
    }
    /// Every queued frame, oldest first; the queue starts empty again.
    func take() -> [Frame] {
        lock.withLock { takeLocked() }
    }
    /// Stops early answers and takes every queued frame, before the open thread changes: the
    /// caller applies them under the generation they were acknowledged for.
    func fence() -> [Frame] {
        lock.withLock {
            open = nil
            return takeLocked()
        }
    }
    /// The thread now open, whose frames may be answered early again; nil while none is.
    func opened(_ thread: String, epoch: Int) {
        lock.withLock { if !closed { open = (thread, epoch) } }
    }
    /// The runtime retired: nothing more is queued or answered. Returns, in order, the queued
    /// frames already acknowledged, which the bridge counts as shown and the caller still applies;
    /// the rest were never answered and are dropped with the runtime, in the same step that closes
    /// the intake, so none decoded meanwhile slips in between.
    func close() -> [Frame] {
        lock.withLock {
            closed = true
            open = nil
            return takeLocked().filter(\.answered)
        }
    }
    private func takeLocked() -> [Frame] {
        defer {
            frames.removeAll(keepingCapacity: true)
            answeredBytes = 0
        }
        return frames
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
