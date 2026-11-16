import Foundation

/// Layout identity for cached row measurements. A measurement taken under one
/// revision must never size a spacer under another: rotation, split-view width,
/// Dynamic Type, density or an opened disclosure invalidates it. Resident
/// content changes (paging, streaming, regrouping) never invalidate: rows
/// carry their own measurements and the extent classifies membership
/// explicitly, so ordinary transcript motion must not shift the scrollbar.
struct TranscriptLayoutRevision: Equatable, Sendable {
    var width: Double
    var height: Double
    /// Description of the Dynamic Type size (e.g. `"large"`, `"accessibility3"`).
    var typeSize: String
    var density: String
    /// Count of opened disclosures; any toggle changes the revision.
    var disclosures: Int

    static let `default` = TranscriptLayoutRevision(
        width: 0, height: 0, typeSize: "", density: "", disclosures: 0)

    /// Revision for the given viewport geometry. Takes no resident-content
    /// input by construction: paging and streaming must not invalidate.
    static func current(width: Double, height: Double, typeSize: String,
                        density: String, disclosures: Int) -> Self {
        Self(width: width, height: height, typeSize: typeSize,
             density: density, disclosures: disclosures)
    }
}

/// Where the reader is: pinned to the live end, reading history freely, or held
/// on a jump/disclosure target while it settles. Mirrors the web scroll-mode
/// kinds (`following` / `free` / `anchoring`) without any I/O.
enum TranscriptMode: Equatable, Sendable {
    case following
    case reading
    case anchoring
}

/// The row the view holds still, and how far its top sits below the viewport's
/// top. Relative to the view, like the web `Held`: a resize already answered by
/// moving the view leaves it unchanged, so no change is ever counted twice.
struct TranscriptHeldAnchor: Equatable, Sendable {
    var rowID: String
    var itemID: String?
    var top: Double
}

/// How the view corrects after rows were added, removed or replaced. Following
/// keeps the end in view; otherwise the view moves by how far the held row
/// drifted, and a jump still landing re-aims at its row's new index.
enum TranscriptCorrection: Equatable, Sendable {
    case end
    case shift(by: Double)
    case aim(index: Int)
    case none
}

/// One native viewport controller. Pure: gestures, scrolls, jumps, row changes
/// and layout revisions in; mode plus correction intent out. SwiftUI supplies
/// geometry and performs the scrolls. No timers, no I/O, inject the clock.
/// Owns the follow mode, scroll direction, semantic anchor (with item identity
/// and deletion successor) and the bounded pending-correction budget.
struct TranscriptViewportController: Equatable, Sendable {
    private(set) var mode: TranscriptMode = .following
    private(set) var held: TranscriptHeldAnchor?
    /// A jump keeps re-aiming at its row while rows around it measure (web
    /// `aimWindow`); 0 means no re-aim (a disclosure toggle).
    private(set) var aimUntil: Double = 0
    /// A post-layout correction still owed; a gesture cancels it.
    private(set) var pendingShift: Double?
    private(set) var correctionFrames = 0
    /// Pending session restore from a saved anchor: the row, an item it shows,
    /// and the desired pixel top. Installed on navigation back; cleared once
    /// the frame settles within tolerance, on budget exhaustion, or by gesture.
    private(set) var sessionAnchor: TranscriptHeldAnchor?
    private(set) var revision = TranscriptLayoutRevision.default
    /// Last scroll direction: -1 up, 1 down, 0 still.
    private(set) var direction = 0
    /// Resident row keys as last seen, for successor search.
    private var lastKeys: [String] = []

    static let aimWindow: Double = 5_000
    static let maxCorrectionFrames = 30
    /// A held row that left hands over to at most this many following rows on.
    static let successorLimit = 8

    var isAiming: Bool { mode == .anchoring && aimUntil > 0 }

    /// A gesture before the scroll it causes. An upward gesture away from the
    /// live end leaves following; a downward one at the end returns to it. Any
    /// gesture cancels a pending correction and stops a jump re-aiming.
    mutating func gesture(upward: Bool, atEnd: Bool, detached: Bool, now: Double) {
        cancelPending()
        aimUntil = 0
        if !upward, atEnd, !detached {
            mode = .following
            held = nil
            return
        }
        if mode == .following, !upward { return }
        mode = .reading
    }

    /// A press (touch down, click): the reader is here; a landing jump stops
    /// re-aiming but keeps its row.
    mutating func press(now: Double) {
        cancelPending()
        if mode == .anchoring, now < aimUntil { aimUntil = 0 }
    }

    /// A scroll event from any cause. Only the reader releases an anchored row;
    /// code scrolling it into place never does. Returning to the end follows it.
    mutating func scrolled(atEnd: Bool, upward: Bool, detached: Bool, gliding: Bool) {
        if gliding { return }
        if mode == .anchoring { return }
        if mode == .following { return }
        if atEnd, !upward, !detached { mode = .following; held = nil }
    }

    /// Bring a row into view and hold it while rows around it measure.
    mutating func jump(rowID: String, itemID: String?, top: Double, now: Double) {
        cancelPending()
        mode = .anchoring
        held = TranscriptHeldAnchor(rowID: rowID, itemID: itemID, top: top)
        aimUntil = now + Self.aimWindow
    }

    /// Opening or closing a disclosure holds its row; what changes is below it.
    mutating func toggle(rowID: String, itemID: String?, top: Double) {
        cancelPending()
        mode = .anchoring
        held = TranscriptHeldAnchor(rowID: rowID, itemID: itemID, top: top)
        aimUntil = 0
    }

    /// Follow the live end again.
    mutating func goLive() {
        cancelPending()
        mode = .following
        held = nil
        aimUntil = 0
    }

    /// The reader left the end (gesture, turn keys, search focus): reading, but
    /// keeps whatever anchor was captured.
    mutating func userLeftEnd() {
        if mode == .following { mode = .reading }
    }

    /// Record the semantic anchor before rows move (the feed's keep-place
    /// capture). Never changes the mode by itself.
    mutating func noteCaptured(rowID: String, itemID: String?, top: Double) {
        held = TranscriptHeldAnchor(rowID: rowID, itemID: itemID, top: top)
    }

    /// Install a saved session anchor for restore after the window rebuilds.
    /// Never changes the follow mode by itself; the feed sets reading mode.
    mutating func noteSessionAnchor(_ anchor: TranscriptHeldAnchor) {
        sessionAnchor = anchor
        held = anchor
    }

    mutating func clearSessionAnchor() {
        sessionAnchor = nil
    }

    /// Unit-point fraction restoring the session anchor's pixel top for a row
    /// of `rowHeight` in the given viewport geometry. Nil when the session
    /// anchor is gone or the row fills the space (fall back to top alignment).
    func sessionRestoreFraction(viewport: Double, topInset: Double,
                                 bottomInset: Double, rowHeight: Double) -> Double? {
        guard let anchor = sessionAnchor else { return nil }
        return TranscriptAnchorPlacement.fraction(top: anchor.top, viewport: viewport,
            topInset: topInset, bottomInset: bottomInset, rowHeight: rowHeight)
    }

    mutating func noteDirection(_ value: Int) { direction = value }

    /// Rows changed: follow the end, or hold the held row where it was.
    /// `locate` resolves a row key (or, failing that, an item identity when
    /// grouping changed) to its key, index and pixel top. `successorOf` gets
    /// first refusal for a gone held row (e.g. item-level successor by creation
    /// sequence); otherwise the nearest following row still shown takes its
    /// place (web `heldSuccessor`), so rows landing above never lose the
    /// reader's place. Remembers the new keys for the next call.
    mutating func residentChanged(
        newKeys: [String],
        locate: (String) -> (key: String, index: Int, top: Double)?,
        successorOf: (String) -> (key: String, index: Int, top: Double)?,
        now: Double
    ) -> TranscriptCorrection {
        defer { lastKeys = newKeys }
        guard mode != .following else { return .end }
        guard let was = held else { return .none }
        if let at = locate(was.rowID) ?? (was.itemID.flatMap { locate($0) }) {
            if isAiming, now < aimUntil { return .aim(index: at.index) }
            // The desired offset stays `was.top`: newly measured geometry moves
            // the correction, never the target. Only a fresh capture (or a
            // gesture/mode change) may move the target.
            let by = at.top - was.top
            held = TranscriptHeldAnchor(rowID: at.key, itemID: was.itemID, top: was.top)
            if by == 0 { return .none }
            pendingShift = by
            correctionFrames = 0
            return .shift(by: by)
        }
        guard let next = successorOf(was.rowID) ?? defaultSuccessor(after: was.rowID, in: newKeys, locate: locate) else {
            held = nil
            return .none
        }
        // Hand over the row identity; the pixel offset carries over so the
        // successor lands where the reader was, not where it happens to be.
        held = TranscriptHeldAnchor(rowID: next.key, itemID: was.itemID, top: was.top)
        if mode == .anchoring {
            aimUntil = 0
        } else {
            mode = .reading
        }
        return .shift(by: next.top - was.top)
    }

    /// Bounded forward scan of the previous resident order for the first row
    /// still shown after a gone held row.
    private func defaultSuccessor(
        after rowID: String, in newKeys: [String],
        locate: (String) -> (key: String, index: Int, top: Double)?
    ) -> (key: String, index: Int, top: Double)? {
        guard let at = lastKeys.firstIndex(of: rowID) else { return nil }
        for key in lastKeys[(at + 1)...].prefix(Self.successorLimit) where newKeys.contains(key) {
            if let found = locate(key) { return found }
        }
        return nil
    }

    /// A layout revision change. Following stays pinned (the shell re-asserts
    /// the end); reading keeps its anchor while measurements invalidate
    /// elsewhere (the extent drops stale heights).
    mutating func layoutChanged(to next: TranscriptLayoutRevision) -> Bool {
        guard next != revision else { return false }
        revision = next
        pendingShift = nil
        correctionFrames = 0
        return mode == .following
    }

    /// A correction was applied; keep it owed for a bounded number of layout
    /// events while lazy rows measure, then settle.
    mutating func noteCorrectionApplied() {
        correctionFrames += 1
        if !canCorrect {
            pendingShift = nil
            sessionAnchor = nil
        }
    }

    var canCorrect: Bool { correctionFrames < Self.maxCorrectionFrames }

    mutating func cancelPending() {
        pendingShift = nil
        correctionFrames = 0
        sessionAnchor = nil
    }
}

/// Align the same fraction of a row and its viewport to retain a pixel offset.
/// Fractions outside 0...1 represent partially clipped rows. A row taller than
/// the viewport has a negative denominator and still has a valid alignment.
enum TranscriptAnchorPlacement {
    static func fraction(top: Double, viewport: Double, topInset: Double,
                         bottomInset: Double, rowHeight: Double) -> Double? {
        let available = viewport - topInset - bottomInset - rowHeight
        guard top.isFinite, available.isFinite, abs(available) > 1 else { return nil }
        return top / available
    }
}

/// Keyboard lift from rectangle intersection, not just vertical overlap: a
/// floating keyboard beside the reading column reserves no vertical space over
/// it. All values in the same coordinate space (points).
enum TranscriptKeyboardLift {
    static func overlap(
        feedMinX: Double, feedMaxX: Double, feedBottom: Double,
        keyboardMinX: Double, keyboardMaxX: Double, keyboardMinY: Double
    ) -> Double {
        guard feedMaxX > keyboardMinX, keyboardMaxX > feedMinX else { return 0 }
        return max(0, feedBottom - keyboardMinY)
    }
}
