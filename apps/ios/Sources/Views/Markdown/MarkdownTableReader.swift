import Markit
import UIKit

/// Reads a table as it grows in a stream, row by row: each row is read with the header and
/// delimiter rows above it and kept, so an update reads and measures only the rows that changed
/// (the last, as it arrives), not the whole table again. Rows of a GitHub table don't depend on
/// one another, so the cells come out as reading the whole table would give them. Link
/// definitions after the table (`MarkdownBlocks`) are read with every row.
@MainActor final class MarkdownTableReader {
    private struct Style: Equatable {
        let flavor: MarkitFlavor
        let theme: MarkitTheme
        let size: UIContentSizeCategory
    }
    private var style: Style?
    /// The header and delimiter rows (with the definitions) last read, and their cells.
    private var head: (source: String, cells: [MarkdownTable.Measured])?
    /// Each body row's cells, by the row's own line and the definitions.
    private var rows: [String: [MarkdownTable.Measured]] = [:]

    func table(source: String, flavor: MarkitFlavor, theme: MarkitTheme, traits: UITraitCollection) -> MarkdownTable {
        let style = Style(flavor: flavor, theme: theme, size: traits.preferredContentSizeCategory)
        if style != self.style {
            self.style = style
            head = nil
            rows = [:]
        }
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        let tableLines = lines.prefix { !$0.allSatisfy { $0 == " " || $0 == "\t" } }
        // What follows the table, its link definitions, goes with each row it is read in.
        let tail = lines.count > tableLines.count ? "\n" + lines[tableLines.count...].joined(separator: "\n") : ""
        guard tableLines.count >= 2 else { return MarkdownTable(source: source, flavor: flavor, theme: theme, traits: traits) }
        let top = String(tableLines[tableLines.startIndex]) + "\n" + tableLines[tableLines.startIndex + 1]
        let headSource = top + tail
        if head?.source != headSource {
            rows = [:]
            head = MarkdownTable.read(headSource, flavor: flavor, theme: theme, traits: traits).map { (headSource, $0.cells) }
        }
        guard let head else { return MarkdownTable(source: source, flavor: flavor, theme: theme, traits: traits) }
        var measured = head.cells
        var kept: [String: [MarkdownTable.Measured]] = [:]
        var row = 1
        for line in tableLines.dropFirst(2) {
            let key = String(line) + tail
            let cells = kept[key] ?? rows[key] ?? (MarkdownTable.read(top + "\n" + key, flavor: flavor, theme: theme, traits: traits)?
                .cells.filter { !$0.cell.header } ?? [])
            kept[key] = cells
            guard !cells.isEmpty else { continue }
            for var each in cells {
                each.cell = each.cell.at(row: row)
                measured.append(each)
            }
            row += 1
        }
        // Only the rows the table holds now are kept: a row that grew leaves its earlier reads.
        rows = kept
        return MarkdownTable(measured: measured, rows: row)
    }
}

private extension MarkdownTable.Cell {
    func at(row: Int) -> Self {
        Self(row: row, column: column, header: header, alignment: alignment, runs: runs, spoken: spoken)
    }
}
