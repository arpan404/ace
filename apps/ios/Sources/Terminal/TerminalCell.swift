import Foundation

/// A cell colour: the default, one of the 256 indexed colours, or 24-bit RGB.
/// Packed in one word so a cell stays 16 bytes.
struct TerminalColour: Hashable, Sendable {
    let raw: UInt32
    static let standard = TerminalColour(raw: 0)
    static func indexed(_ index: Int) -> TerminalColour { TerminalColour(raw: UInt32(max(0, min(255, index))) + 1) }
    static func rgb(_ red: Int, _ green: Int, _ blue: Int) -> TerminalColour {
        let clamp = { (value: Int) in UInt32(max(0, min(255, value))) }
        return TerminalColour(raw: 0x8000_0000 | clamp(red) << 16 | clamp(green) << 8 | clamp(blue))
    }
    var isDefault: Bool { raw == 0 }
    /// The palette index, when this is an indexed colour.
    var index: Int? { raw != 0 && raw & 0x8000_0000 == 0 ? Int(raw) - 1 : nil }
    /// Red, green and blue, when this is a direct colour.
    var components: (UInt8, UInt8, UInt8)? {
        guard raw & 0x8000_0000 != 0 else { return nil }
        return (UInt8(raw >> 16 & 0xff), UInt8(raw >> 8 & 0xff), UInt8(raw & 0xff))
    }
}

/// SGR attributes and the two wide-character markers.
struct TerminalFlags: OptionSet, Hashable, Sendable {
    let rawValue: UInt16
    static let bold = TerminalFlags(rawValue: 1 << 0)
    static let faint = TerminalFlags(rawValue: 1 << 1)
    static let italic = TerminalFlags(rawValue: 1 << 2)
    static let underline = TerminalFlags(rawValue: 1 << 3)
    static let blink = TerminalFlags(rawValue: 1 << 4)
    static let inverse = TerminalFlags(rawValue: 1 << 5)
    static let invisible = TerminalFlags(rawValue: 1 << 6)
    static let strike = TerminalFlags(rawValue: 1 << 7)
    /// The first of the two cells a wide character takes.
    static let wide = TerminalFlags(rawValue: 1 << 8)
    /// The second cell of a wide character: drawn by the first, never on its own.
    static let wideTrail = TerminalFlags(rawValue: 1 << 9)
    static let overline = TerminalFlags(rawValue: 1 << 10)
    /// Flags that describe the character's place, not its style.
    static let placement: TerminalFlags = [.wide, .wideTrail]
}

/// How a run of cells looks: colours plus attributes, without the placement flags.
struct TerminalStyle: Hashable, Sendable {
    var foreground = TerminalColour.standard
    var background = TerminalColour.standard
    var flags: TerminalFlags = []
    static let plain = TerminalStyle()
}

/// One character cell. `scalar` 0 is blank; combining marks live on the line.
struct TerminalCell: Equatable, Sendable {
    var scalar: UInt32 = 0
    var style = TerminalStyle.plain
    /// A blank cell that keeps the given background (erasure uses the current background).
    static func blank(_ background: TerminalColour = .standard) -> TerminalCell {
        var cell = TerminalCell()
        cell.style.background = background
        return cell
    }
    var isBlank: Bool { scalar == 0 || scalar == 0x20 }
}

/// One row of cells. `id` stays with the row as it scrolls, so a renderer can cache it.
struct TerminalLine: Equatable, Sendable {
    var id: UInt64
    var cells: [TerminalCell]
    /// The row ran past the right edge into the next one (soft wrap): copy and search join them.
    var wrapped = false
    /// Combining marks by column, kept apart from the cells so the common case stays small.
    var marks: [Int: String] = [:]

    init(id: UInt64, columns: Int, background: TerminalColour = .standard) {
        self.id = id
        cells = Array(repeating: .blank(background), count: columns)
    }

    /// The row's text with trailing blanks dropped; wide characters count once.
    var text: String {
        var out = String.UnicodeScalarView()
        var pendingSpaces = 0
        for (column, cell) in cells.enumerated() {
            if cell.style.flags.contains(.wideTrail) { continue }
            if cell.scalar == 0 || cell.scalar == 0x20 {
                pendingSpaces += 1
                continue
            }
            for _ in 0..<pendingSpaces { out.append(" ") }
            pendingSpaces = 0
            if let scalar = Unicode.Scalar(cell.scalar) { out.append(scalar) }
            if let mark = marks[column] { out.append(contentsOf: mark.unicodeScalars) }
        }
        return String(out)
    }

    /// Fit the row to `columns`, never leaving half of a wide character at the edge.
    mutating func resize(_ columns: Int) {
        if cells.count > columns {
            cells.removeLast(cells.count - columns)
            if let last = cells.indices.last, cells[last].style.flags.contains(.wide) { cells[last] = .blank() }
            marks = marks.filter { $0.key < columns }
        } else if cells.count < columns {
            cells.append(contentsOf: repeatElement(TerminalCell.blank(), count: columns - cells.count))
        }
    }
}
