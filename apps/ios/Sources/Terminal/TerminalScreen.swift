import Foundation

/// The cursor as DECSC saves it: place, pen, origin mode and character sets.
struct TerminalSavedCursor: Sendable {
    var row = 0
    var column = 0
    var style = TerminalStyle.plain
    var origin = false
    var charsets: [TerminalCharset] = [.ascii, .ascii]
    var shift = 0
    var pendingWrap = false
}

/// What DECSCUSR asked the cursor to look like.
enum TerminalCursorShape: Sendable { case block, underline, bar }

/// Modes that change how input is encoded or the screen is drawn.
struct TerminalModes: Sendable {
    var applicationCursor = false
    var applicationKeypad = false
    var autowrap = true
    var origin = false
    var insert = false
    /// LNM: line feed also returns the carriage.
    var newline = false
    var cursorVisible = true
    var reverseVideo = false
    var bracketedPaste = false
    /// 1000, 1002 or 1003 when the program wants mouse reports; 0 otherwise.
    var mouseTracking = 0
    var sgrMouse = false
    var focusEvents = false
    /// 1007: in the alternate screen, scrolling sends arrow keys.
    var alternateScroll = true
}

/// A VT/xterm screen: the main and alternate buffers, scrollback, cursor, margins, tab stops and
/// modes. Pure state; `TerminalParser` drives it and `TerminalSession` guards it across threads.
struct TerminalScreen: Sendable {
    private(set) var columns: Int
    private(set) var rows: Int
    /// The buffer on screen, `rows` lines of `columns` cells.
    private(set) var lines: [TerminalLine]
    /// The buffer not on screen (the main one while a full-screen program runs).
    private var other: [TerminalLine]
    private(set) var usingAlternate = false
    private(set) var scrollback: TerminalScrollback
    private(set) var cursorRow = 0
    private(set) var cursorColumn = 0
    /// The cursor sits past the last column: the next character wraps first (xterm's way).
    private(set) var pendingWrap = false
    private(set) var modes = TerminalModes()
    private(set) var cursorShape = TerminalCursorShape.block
    private(set) var title = ""
    var style = TerminalStyle.plain
    var top = 0
    var bottom: Int
    var tabs: [Bool]
    var charsets: [TerminalCharset] = [.ascii, .ascii]
    var shift = 0
    var savedMain = TerminalSavedCursor()
    var savedAlternate = TerminalSavedCursor()
    var lastPrinted: Unicode.Scalar?
    /// Bytes the program asked for (device reports); the session sends and clears them.
    var replies = ""
    private var nextId: UInt64 = 1

    init(columns: Int = 80, rows: Int = 24, scrollback: Int = 5_000) {
        self.columns = max(2, columns)
        self.rows = max(1, rows)
        self.scrollback = TerminalScrollback(limit: scrollback)
        bottom = self.rows - 1
        tabs = Self.defaultTabs(self.columns)
        lines = []
        other = []
        lines = makeLines(self.rows)
        other = makeLines(self.rows)
    }

    // MARK: Reading

    /// Every row: scrollback then screen, as text with trailing blanks trimmed.
    var text: String {
        var out: [String] = []
        if !usingAlternate { for index in 0..<scrollback.count { out.append(scrollback[index].text) } }
        for line in lines { out.append(line.text) }
        while let last = out.last, last.isEmpty, out.count > 1 { out.removeLast() }
        return out.joined(separator: "\n")
    }
    /// Rows a viewer can scroll through: none above a full-screen program.
    var historyCount: Int { usingAlternate ? 0 : scrollback.count }
    /// Row `index` of history followed by the screen.
    func line(_ index: Int) -> TerminalLine {
        index < historyCount ? scrollback[index] : lines[index - historyCount]
    }
    func cell(row: Int, column: Int) -> TerminalCell { lines[row].cells[column] }

    // MARK: Printing

    mutating func put(_ input: Unicode.Scalar) {
        let scalar = charsets[shift].map(input)
        let width = TerminalWidth.of(scalar)
        if width == 0 {
            attachMark(scalar)
            return
        }
        if pendingWrap {
            if modes.autowrap { wrapLine() } else { pendingWrap = false }
        }
        if width == 2 && cursorColumn == columns - 1 {
            // A wide character never splits across rows: pad and wrap, or stay put without wrap.
            if modes.autowrap {
                write(.blank(style.background), at: cursorColumn)
                wrapLine()
            } else { return }
        }
        if modes.insert { insertBlanks(width) }
        var cell = TerminalCell(scalar: scalar.value, style: style)
        cell.style.flags.remove(.placement)
        if width == 2 { cell.style.flags.insert(.wide) }
        write(cell, at: cursorColumn)
        if width == 2 {
            var trail = TerminalCell(scalar: 0, style: style)
            trail.style.flags.remove(.placement)
            trail.style.flags.insert(.wideTrail)
            write(trail, at: cursorColumn + 1)
        }
        lastPrinted = scalar
        let next = cursorColumn + width
        if next >= columns {
            cursorColumn = columns - 1
            pendingWrap = true
        } else { cursorColumn = next }
    }

    private mutating func attachMark(_ scalar: Unicode.Scalar) {
        // Marks join the character before the cursor; a wide character's lead holds them.
        var column = pendingWrap ? cursorColumn : cursorColumn - 1
        guard column >= 0 else { return }
        if lines[cursorRow].cells[column].style.flags.contains(.wideTrail), column > 0 { column -= 1 }
        var mark = lines[cursorRow].marks[column] ?? ""
        guard mark.unicodeScalars.count < 16 else { return }
        mark.unicodeScalars.append(scalar)
        lines[cursorRow].marks[column] = mark
    }

    /// Write one cell, first clearing any wide character it would cut in half.
    private mutating func write(_ cell: TerminalCell, at column: Int) {
        guard column >= 0 && column < columns else { return }
        let existing = lines[cursorRow].cells[column].style.flags
        if existing.contains(.wideTrail), column > 0 { lines[cursorRow].cells[column - 1] = .blank(style.background) }
        if existing.contains(.wide), column + 1 < columns, !cell.style.flags.contains(.wide) {
            lines[cursorRow].cells[column + 1] = .blank(style.background)
        }
        lines[cursorRow].cells[column] = cell
        if !lines[cursorRow].marks.isEmpty { lines[cursorRow].marks[column] = nil }
    }

    private mutating func wrapLine() {
        lines[cursorRow].wrapped = true
        pendingWrap = false
        cursorColumn = 0
        index()
    }

    // MARK: Cursor and scrolling

    /// IND / LF: down one row, scrolling the region at its bottom margin.
    mutating func index() {
        pendingWrap = false
        if cursorRow == bottom { scrollUp(1) }
        else if cursorRow < rows - 1 { cursorRow += 1 }
    }
    /// RI: up one row, scrolling the region down at its top margin.
    mutating func reverseIndex() {
        pendingWrap = false
        if cursorRow == top { scrollDown(1) }
        else if cursorRow > 0 { cursorRow -= 1 }
    }
    mutating func carriageReturn() {
        pendingWrap = false
        cursorColumn = 0
    }

    /// Move to an absolute place; rows count from the top margin in origin mode.
    mutating func moveTo(row: Int, column: Int) {
        pendingWrap = false
        let first = modes.origin ? top : 0
        let last = modes.origin ? bottom : rows - 1
        cursorRow = max(first, min(last, first + row))
        cursorColumn = max(0, min(columns - 1, column))
    }
    /// Move relative to the cursor, stopping at the margins when the cursor is inside them.
    mutating func moveBy(rows delta: Int, columns columnDelta: Int) {
        pendingWrap = false
        if delta != 0 {
            let inside = cursorRow >= top && cursorRow <= bottom
            let first = inside ? top : 0
            let last = inside ? bottom : rows - 1
            cursorRow = max(first, min(last, cursorRow + delta))
        }
        cursorColumn = max(0, min(columns - 1, cursorColumn + columnDelta))
    }
    mutating func setColumn(_ column: Int) {
        pendingWrap = false
        cursorColumn = max(0, min(columns - 1, column))
    }

    /// Scroll the region up: its top row leaves (into history on the main screen when the region
    /// starts at the top), a blank row enters at its bottom.
    mutating func scrollUp(_ count: Int) {
        let amount = min(count, bottom - top + 1)
        guard amount > 0 else { return }
        for _ in 0..<amount {
            let leaving = lines.remove(at: top)
            if !usingAlternate && top == 0 { scrollback.append(leaving) }
            lines.insert(blankLine(), at: bottom)
        }
    }
    mutating func scrollDown(_ count: Int) {
        let amount = min(count, bottom - top + 1)
        guard amount > 0 else { return }
        for _ in 0..<amount {
            lines.remove(at: bottom)
            lines.insert(blankLine(), at: top)
        }
    }

    // MARK: Editing

    mutating func insertBlanks(_ count: Int) {
        let amount = min(count, columns - cursorColumn)
        guard amount > 0 else { return }
        var cells = lines[cursorRow].cells
        cells.removeLast(amount)
        cells.insert(contentsOf: repeatElement(.blank(style.background), count: amount), at: cursorColumn)
        lines[cursorRow].cells = cells
        lines[cursorRow].marks = [:]
        repairWide(row: cursorRow)
    }
    mutating func deleteCharacters(_ count: Int) {
        pendingWrap = false
        let amount = min(count, columns - cursorColumn)
        guard amount > 0 else { return }
        lines[cursorRow].cells.removeSubrange(cursorColumn..<(cursorColumn + amount))
        lines[cursorRow].cells.append(contentsOf: repeatElement(.blank(style.background), count: amount))
        lines[cursorRow].marks = [:]
        repairWide(row: cursorRow)
    }
    mutating func eraseCharacters(_ count: Int) {
        pendingWrap = false
        let end = min(columns, cursorColumn + count)
        erase(row: cursorRow, from: cursorColumn, to: end)
    }
    mutating func insertLines(_ count: Int) {
        guard cursorRow >= top && cursorRow <= bottom else { return }
        let amount = min(count, bottom - cursorRow + 1)
        for _ in 0..<amount {
            lines.remove(at: bottom)
            lines.insert(blankLine(), at: cursorRow)
        }
        cursorColumn = 0
        pendingWrap = false
    }
    mutating func deleteLines(_ count: Int) {
        guard cursorRow >= top && cursorRow <= bottom else { return }
        let amount = min(count, bottom - cursorRow + 1)
        for _ in 0..<amount {
            lines.remove(at: cursorRow)
            lines.insert(blankLine(), at: bottom)
        }
        cursorColumn = 0
        pendingWrap = false
    }
    /// ED: 0 below the cursor, 1 above it, 2 the whole screen, 3 the scrollback.
    mutating func eraseDisplay(_ mode: Int) {
        switch mode {
        case 0:
            eraseLine(0)
            for row in (cursorRow + 1)..<rows { lines[row] = blankLine() }
        case 1:
            eraseLine(1)
            for row in 0..<cursorRow { lines[row] = blankLine() }
        case 2:
            for row in 0..<rows { lines[row] = blankLine() }
        case 3:
            scrollback.removeAll()
        default: break
        }
    }
    /// EL: 0 right of the cursor, 1 left of it, 2 the whole row.
    mutating func eraseLine(_ mode: Int) {
        switch mode {
        case 0: erase(row: cursorRow, from: cursorColumn, to: columns); lines[cursorRow].wrapped = false
        case 1: erase(row: cursorRow, from: 0, to: cursorColumn + 1)
        case 2: erase(row: cursorRow, from: 0, to: columns); lines[cursorRow].wrapped = false
        default: break
        }
    }
    private mutating func erase(row: Int, from start: Int, to end: Int) {
        guard start < end else { return }
        let blank = TerminalCell.blank(style.background)
        for column in start..<end { lines[row].cells[column] = blank }
        if !lines[row].marks.isEmpty { lines[row].marks = lines[row].marks.filter { $0.key < start || $0.key >= end } }
        repairWide(row: row)
    }
    /// After a shift or erase, no half of a wide character may stand alone.
    private mutating func repairWide(row: Int) {
        let cells = lines[row].cells
        for column in cells.indices {
            let flags = cells[column].style.flags
            if flags.contains(.wide) && (column + 1 >= cells.count || !cells[column + 1].style.flags.contains(.wideTrail)) {
                lines[row].cells[column] = .blank(cells[column].style.background)
            } else if flags.contains(.wideTrail) && (column == 0 || !cells[column - 1].style.flags.contains(.wide)) {
                lines[row].cells[column] = .blank(cells[column].style.background)
            }
        }
    }

    /// Clear the screen and its history, keeping the cursor's row at the top (Clear terminal).
    mutating func clearHistory() {
        scrollback.removeAll()
        guard !usingAlternate else { return }
        let keep = lines[cursorRow]
        lines = makeLines(rows)
        lines[0] = keep
        cursorRow = 0
    }

    // MARK: Buffers, modes and size

    mutating func setMode(_ change: (inout TerminalModes) -> Void) { change(&modes) }
    mutating func setShape(_ shape: TerminalCursorShape) { cursorShape = shape }
    mutating func setTitle(_ text: String) { title = String(text.prefix(256)) }

    /// Switch to the alternate buffer (a full-screen program) or back to the main one.
    mutating func useAlternate(_ on: Bool, clear: Bool) {
        guard on != usingAlternate else {
            if on && clear { lines = makeLines(rows) }
            return
        }
        swap(&lines, &other)
        usingAlternate = on
        if on && clear { lines = makeLines(rows) }
        pendingWrap = false
    }

    mutating func saveCursor() {
        let saved = TerminalSavedCursor(row: cursorRow, column: cursorColumn, style: style, origin: modes.origin,
                                        charsets: charsets, shift: shift, pendingWrap: pendingWrap)
        if usingAlternate { savedAlternate = saved } else { savedMain = saved }
    }
    mutating func restoreCursor() {
        let saved = usingAlternate ? savedAlternate : savedMain
        cursorRow = min(rows - 1, saved.row)
        cursorColumn = min(columns - 1, saved.column)
        style = saved.style
        modes.origin = saved.origin
        charsets = saved.charsets
        shift = saved.shift
        pendingWrap = saved.pendingWrap
    }

    mutating func setMargins(top first: Int, bottom last: Int) {
        guard first < last, last < rows else { return }
        top = first
        bottom = last
        moveTo(row: 0, column: 0)
    }

    /// DECSTR: modes and pen back to defaults; the screen stays.
    mutating func softReset() {
        modes = TerminalModes()
        style = .plain
        top = 0
        bottom = rows - 1
        charsets = [.ascii, .ascii]
        shift = 0
        savedMain = TerminalSavedCursor()
        savedAlternate = TerminalSavedCursor()
        pendingWrap = false
    }
    /// RIS: everything back to the start, keeping the main screen's history.
    mutating func fullReset() {
        useAlternate(false, clear: false)
        softReset()
        lines = makeLines(rows)
        other = makeLines(rows)
        tabs = Self.defaultTabs(columns)
        cursorRow = 0
        cursorColumn = 0
        cursorShape = .block
        title = ""
    }

    /// Fit both buffers to a new size. Rows leaving the top of the main screen go into history,
    /// and history comes back down when the screen grows taller.
    mutating func resize(columns newColumns: Int, rows newRows: Int) {
        let width = max(2, min(500, newColumns))
        let height = max(1, min(500, newRows))
        guard width != columns || height != rows else { return }
        for index in lines.indices { lines[index].resize(width) }
        for index in other.indices { other[index].resize(width) }
        columns = width
        var mainCursor = usingAlternate ? savedMain.row : cursorRow
        var alternateCursor = usingAlternate ? cursorRow : savedAlternate.row
        var main = usingAlternate ? other : lines
        var alternate = usingAlternate ? lines : other
        Self.fit(&main, rows: height, columns: width, history: &scrollback, ids: &nextId, cursor: &mainCursor)
        var none = TerminalScrollback(limit: 0)
        Self.fit(&alternate, rows: height, columns: width, history: &none, ids: &nextId, cursor: &alternateCursor)
        if usingAlternate {
            lines = alternate; other = main
            cursorRow = alternateCursor; savedMain.row = mainCursor
        } else {
            lines = main; other = alternate
            cursorRow = mainCursor; savedAlternate.row = alternateCursor
        }
        rows = height
        top = 0
        bottom = rows - 1
        tabs = Self.defaultTabs(columns)
        cursorColumn = min(cursorColumn, columns - 1)
        cursorRow = min(cursorRow, rows - 1)
        pendingWrap = false
    }
    /// Fit one buffer to `height` rows. Only the main buffer has history to give rows to and
    /// take them back from.
    private static func fit(_ buffer: inout [TerminalLine], rows height: Int, columns: Int,
                            history: inout TerminalScrollback, ids: inout UInt64, cursor: inout Int) {
        while buffer.count > height {
            // Drop empty rows below the cursor first; otherwise the top row leaves.
            if cursor < buffer.count - 1, buffer[buffer.count - 1].text.isEmpty { buffer.removeLast() }
            else {
                let leaving = buffer.removeFirst()
                history.append(leaving)
                cursor = max(0, cursor - 1)
            }
        }
        while buffer.count < height {
            if let back = history.popLast() {
                var line = back
                line.resize(columns)
                buffer.insert(line, at: 0)
                cursor += 1
            } else {
                buffer.append(TerminalLine(id: ids, columns: columns))
                ids += 1
            }
        }
    }

    // MARK: Helpers

    mutating func blankLine() -> TerminalLine {
        defer { nextId += 1 }
        return TerminalLine(id: nextId, columns: columns, background: style.background)
    }
    private mutating func makeLines(_ count: Int) -> [TerminalLine] {
        (0..<count).map { _ in
            defer { nextId += 1 }
            return TerminalLine(id: nextId, columns: columns)
        }
    }
    static func defaultTabs(_ columns: Int) -> [Bool] { (0..<columns).map { $0 > 0 && $0 % 8 == 0 } }
}
