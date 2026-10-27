import Foundation

/// What each control function does to the screen (ECMA-48, DEC VT100–VT520 and xterm's
/// additions), dispatched from the parser.
extension TerminalScreen: TerminalHandler {
    mutating func print(_ scalar: Unicode.Scalar) { put(scalar) }

    mutating func execute(_ control: UInt32) {
        switch control {
        case 0x08: setColumn(cursorColumn - 1) // BS
        case 0x09: tab(1) // HT
        case 0x0A, 0x0B, 0x0C: // LF, VT, FF
            index()
            if modes.newline { carriageReturn() }
        case 0x0D: carriageReturn()
        case 0x0E: shift = 1 // SO
        case 0x0F: shift = 0 // SI
        default: break // BEL and the rest: nothing to draw
        }
    }

    mutating func esc(intermediates: [UInt32], final: UInt32) {
        if let first = intermediates.first {
            switch (first, final) {
            case (0x28, _), (0x29, _): // ( or ) designates G0 or G1
                charsets[first == 0x28 ? 0 : 1] = final == 0x30 ? .graphics : .ascii
            case (0x23, 0x38): alignmentTest() // ESC # 8
            default: break
            }
            return
        }
        switch final {
        case 0x37: saveCursor() // ESC 7
        case 0x38: restoreCursor() // ESC 8
        case 0x44: index() // IND
        case 0x45: carriageReturn(); index() // NEL
        case 0x48: if cursorColumn < tabs.count { tabs[cursorColumn] = true } // HTS
        case 0x4D: reverseIndex() // RI
        case 0x63: fullReset() // RIS
        case 0x3D: setMode { $0.applicationKeypad = true } // DECKPAM
        case 0x3E: setMode { $0.applicationKeypad = false } // DECKPNM
        default: break
        }
    }

    mutating func csi(_ p: TerminalParameters, marker: UInt32, intermediates: [UInt32], final: UInt32) {
        if marker == 0x3F { // ?
            if final == 0x68 || final == 0x6C { privateModes(p, on: final == 0x68) }
            return
        }
        if marker == 0x3E { // >
            if final == 0x63 { replies += "\u{1b}[>0;10;1c" } // secondary device attributes
            return
        }
        if marker != 0 { return }
        if let intermediate = intermediates.first {
            if intermediate == 0x20 && final == 0x71 { cursorStyle(p.value(0, default: 0)) } // DECSCUSR
            if intermediate == 0x21 && final == 0x70 { softReset() } // DECSTR
            return
        }
        switch final {
        case 0x40: insertBlanks(p.count(0)) // ICH
        case 0x41: moveBy(rows: -p.count(0), columns: 0) // CUU
        case 0x42, 0x65: moveBy(rows: p.count(0), columns: 0) // CUD, VPR
        case 0x43, 0x61: moveBy(rows: 0, columns: p.count(0)) // CUF, HPR
        case 0x44: moveBy(rows: 0, columns: -p.count(0)) // CUB
        case 0x45: moveBy(rows: p.count(0), columns: -columns) // CNL
        case 0x46: moveBy(rows: -p.count(0), columns: -columns) // CPL
        case 0x47, 0x60: setColumn(p.count(0) - 1) // CHA, HPA
        case 0x48, 0x66: moveTo(row: p.count(0) - 1, column: p.count(1) - 1) // CUP, HVP
        case 0x49: tab(p.count(0)) // CHT
        case 0x4A: eraseDisplay(p.value(0, default: 0)) // ED
        case 0x4B: eraseLine(p.value(0, default: 0)) // EL
        case 0x4C: insertLines(p.count(0)) // IL
        case 0x4D: deleteLines(p.count(0)) // DL
        case 0x50: deleteCharacters(p.count(0)) // DCH
        case 0x53: scrollUp(p.count(0)) // SU
        case 0x54: scrollDown(p.count(0)) // SD
        case 0x58: eraseCharacters(p.count(0)) // ECH
        case 0x5A: backTab(p.count(0)) // CBT
        case 0x62: repeatLast(p.count(0)) // REP
        case 0x63: if p.value(0, default: 0) == 0 { replies += "\u{1b}[?62;22c" } // DA
        case 0x64: moveTo(row: p.count(0) - 1, column: cursorColumn) // VPA
        case 0x67: clearTabs(p.value(0, default: 0)) // TBC
        case 0x68, 0x6C: ansiModes(p, on: final == 0x68) // SM, RM
        case 0x6D: graphicRendition(p) // SGR
        case 0x6E: deviceStatus(p.value(0, default: 0)) // DSR
        case 0x72: setMargins(top: p.count(0) - 1, bottom: p.count(1, default: rows) - 1) // DECSTBM
        case 0x73: if p.groups.count <= 1 && p.value(0, default: -1) < 0 { saveCursor() } // SCOSC
        case 0x75: restoreCursor() // SCORC
        default: break
        }
    }

    mutating func osc(_ text: String) {
        let parts = text.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
        guard let code = parts.first.flatMap({ Int($0) }) else { return }
        let value = parts.count > 1 ? String(parts[1]) : ""
        switch code {
        case 0, 2: setTitle(value)
        case 10 where value == "?": replies += "\u{1b}]10;rgb:e6e6/e6e6/e6e6\u{1b}\\"
        case 11 where value == "?": replies += "\u{1b}]11;rgb:1414/1414/1414\u{1b}\\"
        default: break // hyperlinks, palette changes and clipboard writes are not taken
        }
    }

    // MARK: Pieces

    private mutating func privateModes(_ p: TerminalParameters, on: Bool) {
        for group in p.groups {
            guard let mode = group.first, mode >= 0 else { continue }
            switch mode {
            case 1: setMode { $0.applicationCursor = on }
            case 5: setMode { $0.reverseVideo = on }
            case 6:
                setMode { $0.origin = on }
                moveTo(row: 0, column: 0)
            case 7: setMode { $0.autowrap = on }
            case 25: setMode { $0.cursorVisible = on }
            case 47: useAlternate(on, clear: false)
            case 1047:
                if !on && usingAlternate { eraseDisplay(2) }
                useAlternate(on, clear: false)
            case 1048: if on { saveCursor() } else { restoreCursor() }
            case 1049:
                if on {
                    saveCursor()
                    useAlternate(true, clear: true)
                } else {
                    useAlternate(false, clear: false)
                    restoreCursor()
                }
            case 1000, 1002, 1003: setMode { $0.mouseTracking = on ? mode : 0 }
            case 1004: setMode { $0.focusEvents = on }
            case 1006: setMode { $0.sgrMouse = on }
            case 1007: setMode { $0.alternateScroll = on }
            case 2004: setMode { $0.bracketedPaste = on }
            default: break
            }
        }
    }

    private mutating func ansiModes(_ p: TerminalParameters, on: Bool) {
        for group in p.groups {
            switch group.first {
            case 4: setMode { $0.insert = on }
            case 20: setMode { $0.newline = on }
            default: break
            }
        }
    }

    private mutating func deviceStatus(_ request: Int) {
        if request == 5 { replies += "\u{1b}[0n" }
        if request == 6 {
            let row = modes.origin ? cursorRow - top : cursorRow
            replies += "\u{1b}[\(row + 1);\(cursorColumn + 1)R"
        }
    }

    private mutating func cursorStyle(_ value: Int) {
        switch value {
        case 3, 4: setShape(.underline)
        case 5, 6: setShape(.bar)
        default: setShape(.block)
        }
    }

    private mutating func tab(_ count: Int) {
        var column = cursorColumn
        for _ in 0..<min(count, columns) {
            column += 1
            while column < columns - 1 && !tabs[column] { column += 1 }
        }
        setColumn(min(column, columns - 1))
    }
    private mutating func backTab(_ count: Int) {
        var column = cursorColumn
        for _ in 0..<min(count, columns) {
            column -= 1
            while column > 0 && !tabs[column] { column -= 1 }
        }
        setColumn(max(column, 0))
    }
    private mutating func clearTabs(_ mode: Int) {
        if mode == 0, cursorColumn < tabs.count { tabs[cursorColumn] = false }
        if mode == 3 { tabs = Array(repeating: false, count: columns) }
    }
    private mutating func repeatLast(_ count: Int) {
        guard let scalar = lastPrinted else { return }
        for _ in 0..<min(count, columns * rows) { put(scalar) }
    }
    private mutating func alignmentTest() {
        let saved = style
        style = .plain
        for row in 0..<rows {
            moveTo(row: row, column: 0)
            for _ in 0..<columns { put("E") }
        }
        style = saved
        top = 0
        bottom = rows - 1
        moveTo(row: 0, column: 0)
    }

    /// SGR: attributes, the 16 colours with their bright forms, 256 colours and 24-bit colour in
    /// both the `;` and the `:` forms.
    private mutating func graphicRendition(_ p: TerminalParameters) {
        if p.groups.isEmpty { style = .plain; return }
        var index = 0
        let groups = p.groups
        while index < groups.count {
            let group = groups[index]
            let code = max(0, group.first ?? 0)
            switch code {
            case 0: style = .plain
            case 1: style.flags.insert(.bold)
            case 2: style.flags.insert(.faint)
            case 3: style.flags.insert(.italic)
            case 4:
                if group.count > 1 && group[1] == 0 { style.flags.remove(.underline) }
                else { style.flags.insert(.underline) }
            case 5, 6: style.flags.insert(.blink)
            case 7: style.flags.insert(.inverse)
            case 8: style.flags.insert(.invisible)
            case 9: style.flags.insert(.strike)
            case 21: style.flags.insert(.underline)
            case 22: style.flags.remove([.bold, .faint])
            case 23: style.flags.remove(.italic)
            case 24: style.flags.remove(.underline)
            case 25: style.flags.remove(.blink)
            case 27: style.flags.remove(.inverse)
            case 28: style.flags.remove(.invisible)
            case 29: style.flags.remove(.strike)
            case 30...37: style.foreground = .indexed(code - 30)
            case 39: style.foreground = .standard
            case 40...47: style.background = .indexed(code - 40)
            case 49: style.background = .standard
            case 53: style.flags.insert(.overline)
            case 55: style.flags.remove(.overline)
            case 90...97: style.foreground = .indexed(code - 90 + 8)
            case 100...107: style.background = .indexed(code - 100 + 8)
            case 38, 48, 58:
                let (colour, used) = extendedColour(groups, at: index)
                if let colour {
                    if code == 38 { style.foreground = colour } else if code == 48 { style.background = colour }
                }
                index += used
            default: break
            }
            index += 1
        }
    }

    /// A 38/48 colour: `38:5:n`, `38:2::r:g:b` or `38:2:r:g:b` in one group, or the same spread
    /// over `;` groups. Answers the colour and how many extra groups it used.
    private func extendedColour(_ groups: [[Int]], at index: Int) -> (TerminalColour?, Int) {
        let group = groups[index]
        if group.count > 1 {
            let kind = group[1]
            if kind == 5, group.count > 2 { return (.indexed(group[2]), 0) }
            if kind == 2 {
                let values = Array(group.dropFirst(2))
                let rgb = values.count >= 4 ? Array(values.suffix(3)) : values
                if rgb.count == 3 { return (.rgb(rgb[0], rgb[1], rgb[2]), 0) }
            }
            return (nil, 0)
        }
        let next = { (offset: Int) -> Int? in
            index + offset < groups.count ? groups[index + offset].first : nil
        }
        switch next(1) {
        case 5:
            guard let value = next(2) else { return (nil, 1) }
            return (.indexed(value), 2)
        case 2:
            guard let red = next(2), let green = next(3), let blue = next(4) else { return (nil, min(4, groups.count - index - 1)) }
            return (.rgb(red, green, blue), 4)
        default:
            return (nil, 0)
        }
    }
}
