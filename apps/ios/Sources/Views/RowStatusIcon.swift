import SwiftUI

/// A thread row's status icon (`RowStatusMark`, shared with the widgets and the Live Activity),
/// sized for the row and scaled with Dynamic Type. Each in its state's colour (`RowStatus`, from
/// `@ace/themes`). Still, never animated. Decorative: the row says the meaning for VoiceOver.
struct RowStatusIcon: View {
    let kind: String
    let tone: String
    var count: Int? = nil
    @ScaledMetric private var size: CGFloat

    init(kind: String, tone: String, count: Int? = nil, size: CGFloat = AceDesign.Size.icon) {
        self.kind = kind
        self.tone = tone
        self.count = count
        _size = ScaledMetric(wrappedValue: size, relativeTo: .subheadline)
    }

    var body: some View { RowStatusMark(kind: kind, tone: tone, count: count, size: size) }

    static func symbol(_ kind: String) -> String? { RowStatusMark.symbol(kind) }
    @MainActor static func colour(_ tone: String) -> Color { RowStatusMark.colour(tone) }
}
