import CoreGraphics

/// How wide each column of a Markdown table is drawn, from each column's natural width (its
/// widest cell on one line) and its minimum (its widest word or unbreakable piece of code),
/// cell padding included. Pure.
///
/// A table fits the room it has whenever its minimums do: columns that fit keep their natural
/// width, so short labels never wrap, and the wide prose columns share what is left in
/// proportion to their text, wrapping inside it, none past its minimum or past `share` of the
/// room while another column still needs some. Only when the minimums alone overflow is the
/// table wider than the room, and it scrolls sideways.
enum MarkdownTableColumns {
    /// The most of the room one column takes while another is narrower than its text.
    static let share: CGFloat = 0.6

    static func widths(natural: [CGFloat], minimum: [CGFloat], available: CGFloat) -> [CGFloat] {
        let natural = natural.map { ceil(max(0, $0)) }
        let minimum = natural.indices.map { min(natural[$0], ceil(max(0, $0 < minimum.count ? minimum[$0] : 0))) }
        guard !natural.isEmpty else { return [] }
        if !available.isFinite || available <= 0 || natural.reduce(0, +) <= available { return natural }
        let cap = natural.count > 1 ? (available * share).rounded(.down) : available
        // Too many columns or too long a token for the room: readable columns, scrolled.
        if minimum.reduce(0, +) > available { return natural.indices.map { max(minimum[$0], min(natural[$0], cap)) } }

        var widths = [CGFloat?](repeating: nil, count: natural.count)
        var room = available
        func open() -> [Int] { widths.indices.filter { widths[$0] == nil } }
        func fix(_ column: Int, _ width: CGFloat) {
            widths[column] = width
            room -= width
        }
        // Short columns keep their natural width: any that fits an equal share of the room left.
        while case let columns = open(), !columns.isEmpty {
            let equal = room / CGFloat(columns.count)
            let short = columns.filter { natural[$0] <= equal }
            if short.isEmpty { break }
            for column in short { fix(column, natural[column]) }
        }
        // The wide ones share the rest by their natural widths, each within its minimum, its
        // natural width and the cap.
        while case let columns = open(), !columns.isEmpty {
            let total = columns.reduce(0) { $0 + natural[$1] }
            let proportional = { (column: Int) in total > 0 ? room * natural[column] / total : room / CGFloat(columns.count) }
            if let column = columns.first(where: { proportional($0) < minimum[$0] }) { fix(column, minimum[column]); continue }
            if let column = columns.first(where: { proportional($0) > natural[$0] }) { fix(column, natural[column]); continue }
            if columns.count > 1, let column = columns.first(where: { proportional($0) > cap }) { fix(column, cap); continue }
            // Whole points; what rounding leaves goes to the last.
            var used: CGFloat = 0
            for (offset, column) in columns.enumerated() {
                let width = offset == columns.count - 1 ? room - used : proportional(column).rounded(.down)
                widths[column] = width
                used += width
            }
            room = 0
            break
        }
        var result = widths.map { $0 ?? 0 }
        // Columns kept at their natural width give back room for one held at its minimum.
        var over = result.reduce(0, +) - available
        while over > 0, let column = result.indices.filter({ result[$0] > minimum[$0] }).max(by: { result[$0] - minimum[$0] < result[$1] - minimum[$1] }) {
            let give = min(over, result[column] - minimum[column])
            result[column] -= give
            over -= give
        }
        return result
    }
}
