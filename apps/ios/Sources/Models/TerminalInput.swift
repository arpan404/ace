import Foundation

/// One thing typed into a terminal. Keys carry DOM key names ("ArrowUp", "Escape", "c"); the
/// bridge turns them into bytes with the same encoder the web uses (`@ace/client/terminal-keys`).
enum TerminalInput: Equatable, Sendable {
    case text(String)
    case key(String, ctrl: Bool = false, alt: Bool = false, shift: Bool = false)

    var payload: [String: Any] {
        switch self {
        case .text(let text): return ["text": text]
        case .key(let key, let ctrl, let alt, let shift):
            var value: [String: Any] = ["key": key]
            if ctrl { value["ctrl"] = true }
            if alt { value["alt"] = true }
            if shift { value["shift"] = true }
            return value
        }
    }
}

/// A sticky modifier on the key bar: one tap holds it for the next key, a second tap locks it,
/// a third releases it.
enum StickyModifier: Equatable, Sendable {
    case off, once, locked
    var isOn: Bool { self != .off }
    mutating func tap() {
        switch self {
        case .off: self = .once
        case .once: self = .locked
        case .locked: self = .off
        }
    }
    /// A key was sent with this modifier applied.
    mutating func used() { if self == .once { self = .off } }
}

/// Ctrl and Alt from the key bar, applied to whatever is typed next.
struct TerminalModifiers: Equatable, Sendable {
    var ctrl = StickyModifier.off
    var alt = StickyModifier.off

    /// What typing `text` on the software keyboard sends: with a modifier held, the first
    /// character becomes a key carrying it and the rest stays text.
    mutating func apply(text: String) -> [TerminalInput] {
        guard let first = text.first else { return [] }
        let rest = String(text.dropFirst())
        if !ctrl.isOn && !alt.isOn { return [.text(text)] }
        let key = first == "\n" || first == "\r" ? "Enter" : first == "\t" ? "Tab" : String(first)
        let input = TerminalInput.key(key, ctrl: ctrl.isOn, alt: alt.isOn)
        used()
        return rest.isEmpty ? [input] : [input, .text(rest)]
    }
    /// A named key (from the key bar or the keyboard's delete), with any held modifier.
    mutating func apply(key: String) -> TerminalInput {
        let input = TerminalInput.key(key, ctrl: ctrl.isOn, alt: alt.isOn)
        used()
        return input
    }
    private mutating func used() { ctrl.used(); alt.used() }
}

/// Keeps typed input in order with at most one write in flight: input that arrives while a
/// write is out waits and goes as the next write, so fast typing never outruns the bridge.
struct TerminalSendQueue: Sendable {
    static let batchLimit = 512
    private(set) var waiting: [TerminalInput] = []
    private(set) var inFlight = false

    /// Input to send now, or nil when it waits behind the write in flight.
    mutating func add(_ input: [TerminalInput]) -> [TerminalInput]? {
        for item in input { append(item) }
        return inFlight ? nil : next()
    }
    /// The write in flight finished: the next batch to send, if anything waited.
    mutating func finished() -> [TerminalInput]? {
        inFlight = false
        return next()
    }
    /// The terminal changed: nothing typed for the old one is sent.
    mutating func reset() { waiting = []; inFlight = false }

    private mutating func next() -> [TerminalInput]? {
        guard !waiting.isEmpty else { return nil }
        let count = min(waiting.count, Self.batchLimit)
        let batch = Array(waiting.prefix(count))
        waiting.removeFirst(count)
        inFlight = true
        return batch
    }
    private mutating func append(_ item: TerminalInput) {
        // Neighbouring text joins into one item while it stays well under a write's size.
        if case .text(let text) = item, case .text(let previous)? = waiting.last, previous.utf8.count + text.utf8.count <= 2048 {
            waiting[waiting.count - 1] = .text(previous + text)
        } else {
            waiting.append(item)
        }
    }
}

/// What a hardware key press sends, or nil to let the system handle it (plain typing goes
/// through the text field; ⌘ shortcuts stay the app's).
struct HardwareKey: Equatable, Sendable {
    enum Named: Equatable, Sendable {
        case escape, tab, enter, backspace, delete, up, down, left, right
        case home, end, pageUp, pageDown, function(Int)
        var name: String {
            switch self {
            case .escape: "Escape"
            case .tab: "Tab"
            case .enter: "Enter"
            case .backspace: "Backspace"
            case .delete: "Delete"
            case .up: "ArrowUp"
            case .down: "ArrowDown"
            case .left: "ArrowLeft"
            case .right: "ArrowRight"
            case .home: "Home"
            case .end: "End"
            case .pageUp: "PageUp"
            case .pageDown: "PageDown"
            case .function(let n): "F\(n)"
            }
        }
    }
    var named: Named?
    /// The character the key makes with no modifiers but Shift, e.g. "c" for Ctrl-C.
    var character: String
    var ctrl = false
    var alt = false
    var shift = false
    var command = false

    var input: TerminalInput? {
        if command { return nil }
        if let named {
            // Plain Backspace and Enter type as text does; the field already sends those.
            if !ctrl && !alt && !shift && (named == .backspace || named == .enter) { return nil }
            return .key(named.name, ctrl: ctrl, alt: alt, shift: shift)
        }
        guard ctrl || alt, character.count == 1 else { return nil }
        return .key(character, ctrl: ctrl, alt: alt)
    }
}
