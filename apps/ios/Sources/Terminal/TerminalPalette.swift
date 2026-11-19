import UIKit

/// Colours for one appearance: the page's own ink and background as the terminal defaults, a
/// 16-colour set tuned to read on them, the 6×6×6 cube and the grey ramp for 256 colours.
struct TerminalPalette {
    let foreground: CGColor
    let background: CGColor
    let cursor: CGColor
    let selection: CGColor
    let match: CGColor
    let currentMatch: CGColor
    private let indexed: [CGColor]

    init(foreground: UIColor, background: UIColor, dark: Bool) {
        self.foreground = foreground.cgColor
        self.background = background.cgColor
        cursor = foreground.withAlphaComponent(0.85).cgColor
        selection = foreground.withAlphaComponent(0.22).cgColor
        match = UIColor(red: 0.93, green: 0.75, blue: 0.44, alpha: 0.35).cgColor
        currentMatch = UIColor(red: 0.93, green: 0.75, blue: 0.44, alpha: 0.75).cgColor
        let base: [UInt32] = dark
            ? [0x1C1C1E, 0xE4697D, 0x57BD9B, 0xE3C07A, 0x6B90D9, 0xB49CF5, 0x5FC3D1, 0xD4D4D8,
               0x6E6E76, 0xF08A9A, 0x7ED6B6, 0xF0D49A, 0x93AEEA, 0xCBBBFA, 0x8AD8E3, 0xFAFAFA]
            : [0x1C1C1E, 0xA3233A, 0x007856, 0x8A5A00, 0x2A55B0, 0x7456CB, 0x0B7285, 0x5C5C63,
               0x6E6E76, 0xC4304B, 0x0F9068, 0xA86D0F, 0x3A6AD0, 0x8C6DE0, 0x1590A6, 0x3A3A3F]
        var colours = base.map(Self.colour)
        let steps: [CGFloat] = [0, 95, 135, 175, 215, 255]
        for red in steps { for green in steps { for blue in steps {
            colours.append(CGColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: 1))
        } } }
        for level in 0..<24 {
            let value = CGFloat(8 + level * 10) / 255
            colours.append(CGColor(srgbRed: value, green: value, blue: value, alpha: 1))
        }
        indexed = colours
    }

    /// The colour a cell's text or background takes; `nil` for the default background, which
    /// the view already paints.
    func resolve(_ colour: TerminalColour, background isBackground: Bool) -> CGColor? {
        if colour.isDefault { return isBackground ? nil : foreground }
        if let index = colour.index { return indexed[index] }
        if let (red, green, blue) = colour.components {
            return CGColor(srgbRed: CGFloat(red) / 255, green: CGFloat(green) / 255, blue: CGFloat(blue) / 255, alpha: 1)
        }
        return nil
    }

    private static func colour(_ value: UInt32) -> CGColor {
        CGColor(srgbRed: CGFloat(value >> 16 & 255) / 255, green: CGFloat(value >> 8 & 255) / 255,
                blue: CGFloat(value & 255) / 255, alpha: 1)
    }
}
