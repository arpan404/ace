import CoreGraphics
import Foundation

// Pure decisions and event plans for clicks, drags and scrolling. The actor turns them into
// posted events; tests check them without an app.

enum CUMouseButton: String, Equatable { case left, right, middle }

/// Mouse modifiers by name, as the model writes them.
func cuModifierFlags(_ names: [String]) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for name in names {
        switch name.lowercased() {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: throw CUError("bad_action", "Unknown modifier \"\(name)\". Use cmd, shift, alt, ctrl or fn.")
        }
    }
    return flags
}

func cuModifierNames(_ flags: CGEventFlags) -> String {
    [(CGEventFlags.maskCommand, "cmd"), (.maskShift, "shift"), (.maskAlternate, "alt"), (.maskControl, "ctrl"), (.maskSecondaryFn, "fn")]
        .filter { flags.contains($0.0) }.map(\.1).joined(separator: "+")
}

struct CUMouseEvent: Equatable {
    enum Kind: Equatable { case move, down, drag, up }
    let kind: Kind
    let button: CUMouseButton
    let point: CGPoint
    /// 1 for a single click, 2 and 3 for the later presses of a double or triple click.
    let clickState: Int
    /// Pause after posting this event.
    let delayMs: Int
}

/// The outline element under a point, for windows the system cannot hit-test (another
/// Space). A sheet, popover or open menu covering the window takes every point: only its own
/// elements can be hit, and points outside it hit nothing. Among candidates the smallest
/// acting element wins.
func cuHitTest(nodes: [CUNode], point: CGPoint) -> Int? {
    var candidates = nodes
    if let top = nodes.lastIndex(where: { ["AXSheet", "AXPopover", "AXMenu"].contains($0.axRole) }) {
        let depth = nodes[top].depth
        let end = nodes[(top + 1)...].firstIndex { $0.depth <= depth } ?? nodes.endIndex
        candidates = Array(nodes[top..<end])
    }
    let containing = candidates.filter { $0.frame?.contains(point) == true && $0.axRole != "AXWindow" }
    func area(_ node: CUNode) -> CGFloat { (node.frame?.width ?? 0) * (node.frame?.height ?? 0) }
    let acting = containing.filter { $0.axActions.contains("AXPress") || cuTextInputRoles.contains($0.axRole) || ["AXRow", "AXCell", "AXOutlineRow", "AXLink"].contains($0.axRole) }
    return (acting.isEmpty ? containing : acting).min { area($0) < area($1) }?.id
}

/// How posted mouse and wheel events reach the chosen window.
enum CUPointerDelivery: Equatable {
    /// Every event names the chosen window and carries a window-local point. The window
    /// under the person's pointer, including a different window of this app, is irrelevant.
    case windowTargeted
    /// Minimized, ordered out or without a window-server id: events have nowhere to land.
    case unavailable
}

func cuPointerDelivery(onScreen: Bool, otherSpace: Bool, minimized: Bool, hasWindowNumber: Bool) -> CUPointerDelivery {
    guard hasWindowNumber, !minimized else { return .unavailable }
    return onScreen || otherSpace ? .windowTargeted : .unavailable
}

/// The window a window-targeted event is addressed to, with its frame in global points.
struct CUPointerTarget: Equatable {
    let window: CGWindowID
    let frame: CGRect
}

/// A global point in a window's own coordinates: top-left origin, title bar included, the
/// way AppKit reads an event's window location.
func cuWindowPoint(_ point: CGPoint, in target: CUPointerTarget) -> CGPoint {
    CGPoint(x: point.x - target.frame.minX, y: point.y - target.frame.minY)
}

/// How a click reaches the app.
enum CUClickRoute: Equatable {
    case press, pressAncestor, open, showMenu, focus, selectRow, selectWord, selectLine, post
}

/// What the click decision depends on, read from the target element.
struct CUClickFacts {
    var byId: Bool
    var button: CUMouseButton = .left
    var count: Int = 1
    /// Modifiers or a hold: only real mouse events carry those.
    var modified: Bool = false
    var actions: [String] = []
    var role: String = ""
    var selectableRow: Bool = false
    var pressableAncestor: Bool = false
    /// Whether posted events can land (see `CUPointerDelivery`).
    var pointerLands: Bool = true
}

/// Accessibility for plain clicks on an element the model named, real events otherwise. A
/// point click presses through AX only when the element under the point is itself the
/// pressable one; anything else gets a real click at that point, unless the window is
/// minimized or hidden, where a real click cannot land and the nearest AX equivalent is the
/// best try.
func cuClickRoute(_ facts: CUClickFacts) -> CUClickRoute {
    if facts.modified || facts.button == .middle { return .post }
    let text = cuTextInputRoles.contains(facts.role)
    let precise = !facts.byId && facts.pointerLands
    if facts.button == .right { return facts.actions.contains("AXShowMenu") ? .showMenu : .post }
    switch facts.count {
    case 1:
        if facts.actions.contains("AXPress") { return .press }
        if precise { return .post }
        if text { return .focus }
        if facts.selectableRow { return .selectRow }
        if facts.pressableAncestor { return .pressAncestor }
        return .post
    case 2:
        if facts.actions.contains("AXOpen") { return .open }
        if text, !precise { return .selectWord }
        return .post
    default:
        if text, !precise { return .selectLine }
        return .post
    }
}

/// Moves to the point, then `count` presses with rising click state. A hold keeps the last
/// press down before it is released.
func cuClickEvents(at point: CGPoint, button: CUMouseButton, count: Int, holdMs: Int) -> [CUMouseEvent] {
    var events = [CUMouseEvent(kind: .move, button: button, point: point, clickState: 0, delayMs: 15)]
    let presses = max(1, min(count, 3))
    for press in 1...presses {
        let last = press == presses
        events.append(CUMouseEvent(kind: .down, button: button, point: point, clickState: press, delayMs: last ? max(holdMs, 20) : 20))
        events.append(CUMouseEvent(kind: .up, button: button, point: point, clickState: press, delayMs: last ? 0 : 30))
    }
    return events
}

/// Press at the start, wait out the hold, nudge past the drag threshold, glide in steps of
/// about 12 points, pause on the target so it can react, then release there.
func cuDragEvents(from start: CGPoint, to end: CGPoint, holdMs: Int) -> [CUMouseEvent] {
    let distance = hypot(end.x - start.x, end.y - start.y)
    let steps = max(8, min(40, Int(distance / 12)))
    var events = [
        CUMouseEvent(kind: .move, button: .left, point: start, clickState: 0, delayMs: 20),
        CUMouseEvent(kind: .down, button: .left, point: start, clickState: 1, delayMs: max(holdMs, 60)),
    ]
    if distance > 0 {
        let nudge = min(4, distance) / distance
        events.append(CUMouseEvent(kind: .drag, button: .left, point: CGPoint(x: start.x + (end.x - start.x) * nudge, y: start.y + (end.y - start.y) * nudge), clickState: 1, delayMs: 30))
    }
    for step in 1...steps {
        let fraction = Double(step) / Double(steps)
        let point = CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
        events.append(CUMouseEvent(kind: .drag, button: .left, point: point, clickState: 1, delayMs: step == steps ? 80 : 10))
    }
    events.append(CUMouseEvent(kind: .up, button: .left, point: end, clickState: 1, delayMs: 0))
    return events
}

struct CUWheelDelta: Equatable {
    let dx: Int32
    let dy: Int32
}

/// The distance a scroll covers, in points: explicit pixels, or pages of 80% of the visible
/// height (vertical) or width (horizontal).
func cuScrollDistance(direction: String, pages: Double?, pixels: Double?, viewport: CGSize) -> Double {
    if let pixels { return max(1, min(pixels, 20_000)) }
    let page = (direction == "left" || direction == "right" ? viewport.width : viewport.height) * 0.8
    return max(1, Double(page) * max(0.1, min(pages ?? 1, 20)))
}

/// Wheel events covering `distance`, at most `step` points each (apps clamp huge deltas).
/// Wheel deltas are positive for up and left.
func cuWheelDeltas(direction: String, distance: Double, step: Double = 400) -> [CUWheelDelta] {
    var left = distance.rounded()
    var deltas: [CUWheelDelta] = []
    while left > 0 {
        let amount = Int32(min(left, step))
        left -= Double(amount)
        switch direction {
        case "up": deltas.append(CUWheelDelta(dx: 0, dy: amount))
        case "down": deltas.append(CUWheelDelta(dx: 0, dy: -amount))
        case "left": deltas.append(CUWheelDelta(dx: amount, dy: 0))
        default: deltas.append(CUWheelDelta(dx: -amount, dy: 0))
        }
    }
    return deltas
}

/// How far content must move so `element` sits inside `visible`: positive when the element is
/// below or right of view. Zero when it already fits (or cannot fit any better).
func cuRevealOffset(element: CGRect, visible: CGRect) -> CGVector {
    func axis(_ low: CGFloat, _ high: CGFloat, _ viewLow: CGFloat, _ viewHigh: CGFloat) -> CGFloat {
        // An element at least as large as the view is in view once it overlaps it.
        if high - low >= viewHigh - viewLow {
            if low < viewHigh && high > viewLow { return 0 }
            return low >= viewHigh ? low - viewLow : high - viewHigh
        }
        if low < viewLow { return low - viewLow }
        if high > viewHigh { return min(high - viewHigh, low - viewLow) }
        return 0
    }
    return CGVector(dx: axis(element.minX, element.maxX, visible.minX, visible.maxX), dy: axis(element.minY, element.maxY, visible.minY, visible.maxY))
}

/// The word around a UTF-16 offset: letters, digits and underscores, or the single other
/// character there.
func cuWordRange(in text: String, at offset: Int) -> NSRange {
    let string = text as NSString
    guard string.length > 0 else { return NSRange(location: 0, length: 0) }
    let index = max(0, min(offset, string.length - 1))
    func isWord(_ at: Int) -> Bool {
        guard let scalar = Unicode.Scalar(string.character(at: at)) else { return true }
        return CharacterSet.alphanumerics.contains(scalar) || scalar == "_"
    }
    guard isWord(index) else { return NSRange(location: index, length: 1) }
    var start = index, end = index + 1
    while start > 0, isWord(start - 1) { start -= 1 }
    while end < string.length, isWord(end) { end += 1 }
    return NSRange(location: start, length: end - start)
}
