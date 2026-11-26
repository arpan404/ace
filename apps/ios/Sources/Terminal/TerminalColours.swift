import Foundation

/// The colours a program changed with OSC 4, 10, 11 or 12, and what answers its queries. The
/// screen keeps these so they outlive a redraw, and the view applies them over the theme's own
/// palette. Only the changed entries are held; the rest are the standard xterm palette, which is
/// what a query is answered with (the phone's tinted theme is a drawing choice, not a program's).
struct TerminalColours: Hashable, Sendable {
    /// 24-bit colours a program gave to indexed palette entries (`OSC 4`).
    private(set) var indexed: [Int: TerminalColour] = [:]
    var foreground: TerminalColour?
    var background: TerminalColour?
    var cursor: TerminalColour?

    /// What the screen answers with when a program asks for a colour it never changed. The ink
    /// and page follow ace's dark page, as the emulator did before it could be asked.
    static let defaultForeground = TerminalColour.rgb(0xE6, 0xE6, 0xE6)
    static let defaultBackground = TerminalColour.rgb(0x14, 0x14, 0x14)
    static let defaultCursor = defaultForeground

    mutating func set(_ colour: TerminalColour, at index: Int) {
        guard (0...255).contains(index) else { return }
        indexed[index] = colour
    }

    /// OSC 104: the listed indexes, or all of them.
    mutating func reset(indexes: [Int]) {
        if indexes.isEmpty { indexed.removeAll() } else { for index in indexes { indexed.removeValue(forKey: index) } }
    }

    mutating func set(_ colour: TerminalColour, _ slot: TerminalSpecialColour) {
        switch slot {
        case .foreground: foreground = colour
        case .background: background = colour
        case .cursor: cursor = colour
        }
    }

    mutating func reset(_ slot: TerminalSpecialColour) {
        switch slot {
        case .foreground: foreground = nil
        case .background: background = nil
        case .cursor: cursor = nil
        }
    }

    /// The colour `index` is now: what a program set, else the standard xterm palette.
    func colour(at index: Int) -> TerminalColour {
        indexed[index] ?? Self.standard[index]
    }

    /// The colour `slot` is now: what a program set, else the screen's default.
    func colour(_ slot: TerminalSpecialColour) -> TerminalColour {
        switch slot {
        case .foreground: foreground ?? Self.defaultForeground
        case .background: background ?? Self.defaultBackground
        case .cursor: cursor ?? Self.defaultCursor
        }
    }

    /// xterm's 256 colours: its Tango first sixteen, the 6×6×6 cube and the grey ramp.
    static let standard: [TerminalColour] = {
        let base: [(Int, Int, Int)] = [
            (0x2E, 0x34, 0x36), (0xCC, 0x00, 0x00), (0x4E, 0x9A, 0x06), (0xC4, 0xA0, 0x00),
            (0x34, 0x65, 0xA4), (0x75, 0x50, 0x7B), (0x06, 0x98, 0x9A), (0xD3, 0xD7, 0xCF),
            (0x55, 0x57, 0x53), (0xEF, 0x29, 0x29), (0x8A, 0xE2, 0x34), (0xFC, 0xE9, 0x4F),
            (0x72, 0x9F, 0xCF), (0xAD, 0x7F, 0xA8), (0x34, 0xE2, 0xE2), (0xEE, 0xEE, 0xEC),
        ]
        var colours = base.map { TerminalColour.rgb($0.0, $0.1, $0.2) }
        let steps = [0, 95, 135, 175, 215, 255]
        for red in steps { for green in steps { for blue in steps {
            colours.append(.rgb(red, green, blue))
        } } }
        for level in 0..<24 {
            let value = 8 + level * 10
            colours.append(.rgb(value, value, value))
        }
        return colours
    }()

    /// `rgb:rrrr/gggg/bbbb`, xterm's answer to a colour query.
    static func reply(_ colour: TerminalColour) -> String {
        guard let (red, green, blue) = colour.components else { return "rgb:0000/0000/0000" }
        func channel(_ value: UInt8) -> String { String(format: "%02x%02x", value, value) }
        return "rgb:\(channel(red))/\(channel(green))/\(channel(blue))"
    }
}
