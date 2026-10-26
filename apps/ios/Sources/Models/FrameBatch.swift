import Foundation
import QuartzCore

/// Bridge frames held so they reach the screen together, as the web's store tells React once
/// per animation frame rather than once per message.
///
/// Frames that arrive within about a display frame of each other apply as one change, so an
/// update the bridge splits over several frames never shows half applied. New rows are paced as
/// well: when a provider runs tools back to back, each one adding rows, the first change after a
/// quiet spell shows at once and the rest of the burst lands together a few times a second,
/// instead of the work log re-laying out for every tool. Edits to rows already on screen
/// (streaming text, a step finishing) keep the display frame's pace.
///
/// Each frame is still acknowledged as it arrives, so the bridge sends the next one at once. A
/// streaming edit in a later frame applies to the text a held frame will show (`text`), the text
/// the bridge's ledger believes native holds.
@MainActor final class FrameBatch {
    /// How long the first held frame waits for others to join it, in ms: about a display frame.
    nonisolated static let window = 12.0
    /// The least time between two flushes that add rows to the open thread, in ms.
    nonisolated static let rowPace = 120.0

    private(set) var held: [BridgePatch] = []
    /// The held frames' size, for tracing.
    private(set) var bytes = 0
    /// When the oldest held frame arrived, in ms.
    private(set) var heldSince: Double?
    /// The held frames add rows to the open thread.
    private(set) var addsRows = false
    /// When a flush last added rows, in ms.
    private var rowsAt: Double?
    /// The text each held item row will show once applied, by thread, epoch and item; nil for a
    /// row a held patch removes.
    private var texts: [String: String?] = [:]
    /// Threads (by id and epoch) a held reset clears: what they show now no longer counts.
    private var cleared: Set<String> = []

    /// When frames held since `heldSince` should apply: a display frame after the first, or for
    /// new rows not before `rowPace` after the last flush that added rows.
    nonisolated static func due(heldSince: Double, addsRows: Bool, rowsAt: Double?) -> Double {
        let soon = heldSince + window
        guard addsRows, let rowsAt else { return soon }
        return max(soon, rowsAt + rowPace)
    }
    /// When everything held should apply; nil while nothing is held.
    var due: Double? { heldSince.map { Self.due(heldSince: $0, addsRows: addsRows, rowsAt: rowsAt) } }

    /// What an item of the thread `id` at `epoch` will show once everything held applies,
    /// given what it shows now.
    func text(_ id: String, _ epoch: Int, _ itemId: String, shown: () -> String?) -> String? {
        if let held = texts[Self.key(id, epoch, itemId)] { return held }
        return cleared.contains(Self.scope(id, epoch)) ? nil : shown()
    }
    /// Notes what `patch` will change once applied, for edits resolved after it.
    func note(_ patch: BridgePatch) {
        switch patch {
        case .threadReset(let id, let epoch):
            let scope = Self.scope(id, epoch)
            cleared.insert(scope)
            texts = texts.filter { !$0.key.hasPrefix(scope) }
        case .item(let id, let epoch, let itemId, let row):
            texts[Self.key(id, epoch, itemId)] = .some(row?.text)
        default: break
        }
    }
    /// What the batch knows of held text, to put back when a frame is turned down part way.
    struct Mark { fileprivate let texts: [String: String?]; fileprivate let cleared: Set<String> }
    func mark() -> Mark { Mark(texts: texts, cleared: cleared) }
    func restore(_ mark: Mark) { texts = mark.texts; cleared = mark.cleared }
    /// Holds a resolved frame that arrived at `now`; `addsRows` when it adds rows to the open
    /// thread after it first loaded.
    func hold(_ patches: [BridgePatch], bytes: Int, at now: Double, addsRows: Bool) {
        guard !patches.isEmpty else { return }
        held.append(contentsOf: patches)
        self.bytes += bytes
        if heldSince == nil { heldSince = now }
        if addsRows { self.addsRows = true }
    }
    /// Everything held, in arrival order, applied at `now`; the batch starts afresh.
    func take(at now: Double) -> [BridgePatch] {
        let taken = held
        if addsRows { rowsAt = now }
        clear()
        return taken
    }
    /// Drops everything held, for a new connection or a retired runtime.
    func reset() {
        clear()
        rowsAt = nil
    }
    private func clear() {
        held = []
        bytes = 0
        heldSince = nil
        addsRows = false
        texts = [:]
        cleared = []
    }
    private static func scope(_ id: String, _ epoch: Int) -> String { "\(id)\u{0}\(epoch)\u{0}" }
    private static func key(_ id: String, _ epoch: Int, _ itemId: String) -> String { scope(id, epoch) + itemId }
}

/// When held bridge frames apply: a monotonic clock in ms (never the wall clock, which can step
/// back) and a wait. Injected so tests run without real time.
struct FrameTiming: Sendable {
    let now: @MainActor @Sendable () -> Double
    let wait: @Sendable (Double) async -> Void
    static let live = FrameTiming(now: { CACurrentMediaTime() * 1000 }, wait: { ms in try? await Task.sleep(for: .milliseconds(ms)) })
    /// Time stands still and waits end at once: held frames apply on the main actor's next turns.
    static let immediate = FrameTiming(now: { 0 }, wait: { _ in })
}
