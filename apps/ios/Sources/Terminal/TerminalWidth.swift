import Foundation

/// How many cells a character takes: 0 for combining marks and joiners, 2 for East Asian wide
/// and full-width characters and emoji shown as emoji, 1 otherwise.
enum TerminalWidth {
    /// East Asian Wide and Fullwidth blocks (Unicode Standard Annex #11), outside the emoji
    /// property, which `isEmojiPresentation` covers.
    private static let wide: [ClosedRange<UInt32>] = [
        0x1100...0x115F, 0x2329...0x232A, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF,
        0x4E00...0x9FFF, 0xA000...0xA4CF, 0xA960...0xA97F, 0xAC00...0xD7A3, 0xF900...0xFAFF,
        0xFE10...0xFE19, 0xFE30...0xFE6F, 0xFF00...0xFF60, 0xFFE0...0xFFE6, 0x16FE0...0x16FE4,
        0x17000...0x18AFF, 0x1B000...0x1B2FF, 0x1F200...0x1F2FF, 0x20000...0x2FFFD, 0x30000...0x3FFFD,
    ]

    static func of(_ scalar: Unicode.Scalar) -> Int {
        let value = scalar.value
        // Printable ASCII and Latin-1 are the hot path: no property lookups.
        if value < 0x300 { return 1 }
        if value == 0x200B || value == 0x200C || value == 0x200D || value == 0x2060 { return 0 }
        if (0xFE00...0xFE0F).contains(value) || (0xE0100...0xE01EF).contains(value) { return 0 }
        let properties = scalar.properties
        switch properties.generalCategory {
        case .nonspacingMark, .enclosingMark, .format: return 0
        default: break
        }
        if properties.isEmojiPresentation { return 2 }
        // Binary search over the sorted ranges.
        var low = 0
        var high = wide.count - 1
        while low <= high {
            let middle = (low + high) / 2
            let range = wide[middle]
            if value < range.lowerBound { high = middle - 1 }
            else if value > range.upperBound { low = middle + 1 }
            else { return 2 }
        }
        return 1
    }
}

/// The DEC Special Graphics set (VT100 line drawing), mapped to Unicode box drawing.
enum TerminalCharset: Sendable {
    case ascii, graphics

    func map(_ scalar: Unicode.Scalar) -> Unicode.Scalar {
        guard self == .graphics, (0x5F...0x7E).contains(scalar.value) else { return scalar }
        let table: [UInt32] = [
            0x00A0, 0x25C6, 0x2592, 0x2409, 0x240C, 0x240D, 0x240A, 0x00B0, 0x00B1, 0x2424, 0x240B,
            0x2518, 0x2510, 0x250C, 0x2514, 0x253C, 0x23BA, 0x23BB, 0x2500, 0x23BC, 0x23BD, 0x251C,
            0x2524, 0x2534, 0x252C, 0x2502, 0x2264, 0x2265, 0x03C0, 0x2260, 0x00A3, 0x00B7,
        ]
        return Unicode.Scalar(table[Int(scalar.value - 0x5F)]) ?? scalar
    }
}
