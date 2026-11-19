import Foundation

/// Find in a terminal: every place `query` appears in history and screen, case-insensitively,
/// in columns (a wide character counts as its two cells). Bounded so a huge history stays quick.
enum TerminalFind {
    static let limit = 1_000

    static func matches(of query: String, in screen: TerminalScreen) -> [TerminalMatch] {
        let needle = Array(query.lowercased().unicodeScalars)
        guard !needle.isEmpty else { return [] }
        var found: [TerminalMatch] = []
        let total = screen.historyCount + screen.rows
        for index in 0..<total {
            let line = screen.line(index)
            // One scalar per character, with the column it starts at.
            var scalars: [Unicode.Scalar] = []
            var columns: [Int] = []
            scalars.reserveCapacity(line.cells.count)
            for (column, cell) in line.cells.enumerated() where !cell.style.flags.contains(.wideTrail) {
                let scalar = Unicode.Scalar(cell.scalar == 0 ? 0x20 : cell.scalar) ?? " "
                scalars.append(contentsOf: String(scalar).lowercased().unicodeScalars.prefix(1))
                columns.append(column)
            }
            guard scalars.count >= needle.count else { continue }
            var start = 0
            while start + needle.count <= scalars.count {
                if scalars[start] == needle[0] && Array(scalars[start..<(start + needle.count)]) == needle {
                    let first = columns[start]
                    let lastIndex = start + needle.count - 1
                    let wide = line.cells[columns[lastIndex]].style.flags.contains(.wide) ? 2 : 1
                    found.append(TerminalMatch(lineId: line.id, column: first, length: columns[lastIndex] + wide - first))
                    if found.count >= limit { return found }
                    start += needle.count
                } else { start += 1 }
            }
        }
        return found
    }
}
