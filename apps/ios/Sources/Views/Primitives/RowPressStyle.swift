import SwiftUI

/// A list row's press (DESIGN.md §3 list rows, §5 press): no dividers; while pressed, or while
/// `selected` (the page open beside or under the list), the row takes a soft fill with 16pt
/// continuous corners. Rows stay flat: no shadow, no tint.
struct RowPressStyle: ButtonStyle {
    var selected = false
    @Environment(\.aceReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: AceDesign.Size.rowCorner, style: .continuous)
        configuration.label
            .background(AceDesign.Surface.fill.opacity(configuration.isPressed || selected ? 1 : 0), in: shape)
            .scaleEffect(configuration.isPressed && !reduceMotion ? AceDesign.Motion.pressScale : 1)
            .animation(AceDesign.Motion.press, value: configuration.isPressed)
            .contentShape(shape)
    }
}

extension ButtonStyle where Self == RowPressStyle {
    static var row: RowPressStyle { RowPressStyle() }
}
