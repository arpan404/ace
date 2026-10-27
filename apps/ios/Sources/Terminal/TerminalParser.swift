import Foundation

/// A control sequence's parameters: groups split by `;`, each with its `:` sub-parameters.
/// A missing value is -1, so `CSI ;5H` keeps its empty first parameter.
struct TerminalParameters: Sendable {
    fileprivate(set) var groups: [[Int]] = []

    /// The first value of group `index`, or `fallback` when absent or zero-defaulted.
    func value(_ index: Int, default fallback: Int) -> Int {
        guard index < groups.count, let first = groups[index].first, first >= 0 else { return fallback }
        return first
    }
    /// Like `value`, but 0 also means the default (cursor counts: `CSI 0A` moves one).
    func count(_ index: Int, default fallback: Int = 1) -> Int {
        let raw = value(index, default: fallback)
        return raw == 0 ? fallback : raw
    }
    var isEmpty: Bool { groups.isEmpty }
}

/// Receives what the parser recognises; `TerminalScreen` acts on it.
protocol TerminalHandler {
    mutating func print(_ scalar: Unicode.Scalar)
    mutating func execute(_ control: UInt32)
    /// `marker` is a private-parameter prefix such as `?` or `>`; `intermediates` are 0x20–0x2F.
    mutating func csi(_ parameters: TerminalParameters, marker: UInt32, intermediates: [UInt32], final: UInt32)
    mutating func esc(intermediates: [UInt32], final: UInt32)
    mutating func osc(_ text: String)
    /// The handler has done as much work as one hold of the screen lock should; the parser
    /// stops after the current character so the lock can be let go.
    var budgetSpent: Bool { get }
}

/// The state machine for ECMA-48 and the DEC/xterm extensions: ground, escape, control
/// sequence, operating-system command and device control string (ignored). It runs on decoded
/// Unicode scalars, keeps partial sequences across calls, and bounds everything it collects.
struct TerminalParser: Sendable {
    private enum State: Sendable { case ground, escape, csi, csiIgnore, osc, oscEscape, string, stringEscape }
    private var state = State.ground
    private var parameters = TerminalParameters()
    private var current = -1
    private var currentGroup: [Int] = []
    private var marker: UInt32 = 0
    private var intermediates: [UInt32] = []
    private var oscText = String.UnicodeScalarView()
    /// Scalars kept of the OSC string; counting the view each time would cost its length.
    private var oscLength = 0

    private static let maxParameters = 32
    private static let maxOsc = 4096
    /// Colon sub-parameters one parameter may carry (`38:2::r:g:b` needs six).
    private static let maxSubParameters = 16

    /// Forget any partial sequence: output after a gap must not finish one from before it.
    mutating func reset() {
        state = .ground
        clearSequence()
    }

    mutating func feed<Handler: TerminalHandler>(_ text: String, into handler: inout Handler) {
        for scalar in text.unicodeScalars { step(scalar, &handler) }
    }

    /// Feed until `handler` has spent its work budget or the text ends; answers where it stopped.
    mutating func feed<Handler: TerminalHandler>(
        _ scalars: Substring.UnicodeScalarView, into handler: inout Handler
    ) -> Substring.UnicodeScalarView.Index {
        var index = scalars.startIndex
        while index < scalars.endIndex {
            step(scalars[index], &handler)
            index = scalars.index(after: index)
            if handler.budgetSpent { break }
        }
        return index
    }

    @inline(__always)
    private mutating func step<Handler: TerminalHandler>(_ scalar: Unicode.Scalar, _ handler: inout Handler) {
        let value = scalar.value
        // CAN and SUB abort any sequence; ESC starts a new one from anywhere except inside strings.
        if value == 0x18 || value == 0x1A {
            state = .ground
            return
        }
        switch state {
        case .ground:
            if value >= 0x20 && value != 0x7F && !(0x80...0x9F).contains(value) { handler.print(scalar) }
            else if value == 0x1B { enterEscape() }
            else if value < 0x20 { handler.execute(value) }
        case .escape:
            if value < 0x20 {
                if value == 0x1B { enterEscape() } else { handler.execute(value) }
            } else if (0x20...0x2F).contains(value) {
                if intermediates.count < 4 { intermediates.append(value) }
            } else if value == 0x5B && intermediates.isEmpty { // [
                state = .csi
            } else if value == 0x5D && intermediates.isEmpty { // ]
                state = .osc
                oscText = String.UnicodeScalarView()
                oscLength = 0
            } else if (value == 0x50 || value == 0x58 || value == 0x5E || value == 0x5F) && intermediates.isEmpty {
                state = .string // DCS, SOS, PM, APC: read to the terminator and drop
            } else if value != 0x7F {
                handler.esc(intermediates: intermediates, final: value)
                state = .ground
            }
        case .csi:
            if value < 0x20 {
                if value == 0x1B { enterEscape() } else { handler.execute(value) }
            } else if (0x30...0x39).contains(value) {
                let digit = Int(value - 0x30)
                current = current < 0 ? digit : min(current * 10 + digit, 65_535)
            } else if value == 0x3B { // ;
                endGroup()
            } else if value == 0x3A { // :
                // Past the cap the sequence is malformed: drop it rather than grow without end.
                if currentGroup.count >= Self.maxSubParameters { state = .csiIgnore }
                else {
                    currentGroup.append(current)
                    current = -1
                }
            } else if (0x3C...0x3F).contains(value) {
                // A private marker only leads; anywhere else the sequence is malformed.
                if parameters.groups.isEmpty && currentGroup.isEmpty && current < 0 && marker == 0 && intermediates.isEmpty { marker = value }
                else { state = .csiIgnore }
            } else if (0x20...0x2F).contains(value) {
                if intermediates.count < 4 { intermediates.append(value) } else { state = .csiIgnore }
            } else if (0x40...0x7E).contains(value) {
                endGroup()
                handler.csi(parameters, marker: marker, intermediates: intermediates, final: value)
                state = .ground
            }
        case .csiIgnore:
            if value == 0x1B { enterEscape() }
            else if (0x40...0x7E).contains(value) { state = .ground }
            else if value < 0x20 { handler.execute(value) }
        case .osc:
            if value == 0x07 { finishOsc(&handler) }
            else if value == 0x1B { state = .oscEscape }
            else if value >= 0x20 && oscLength < Self.maxOsc {
                oscText.append(scalar)
                oscLength += 1
            }
        case .oscEscape:
            // ESC \ ends it; any other ESC sequence ends it too and starts afresh.
            finishOsc(&handler)
            if value != 0x5C {
                enterEscape()
                step(scalar, &handler)
            }
        case .string:
            if value == 0x07 { state = .ground }
            else if value == 0x1B { state = .stringEscape }
        case .stringEscape:
            state = value == 0x5C ? .ground : .string
            if value == 0x1B { state = .stringEscape }
        }
    }

    private mutating func enterEscape() {
        state = .escape
        clearSequence()
    }
    private mutating func clearSequence() {
        parameters = TerminalParameters()
        current = -1
        currentGroup = []
        marker = 0
        intermediates = []
    }
    private mutating func endGroup() {
        currentGroup.append(current)
        if parameters.groups.count < Self.maxParameters { parameters.groups.append(currentGroup) }
        currentGroup = []
        current = -1
    }
    private mutating func finishOsc<Handler: TerminalHandler>(_ handler: inout Handler) {
        state = .ground
        handler.osc(String(oscText))
        oscText = String.UnicodeScalarView()
        oscLength = 0
    }
}
