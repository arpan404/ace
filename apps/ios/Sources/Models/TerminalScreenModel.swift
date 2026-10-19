import Foundation
import Observation

struct TerminalOutputPatch: Decodable, Sendable {
    struct Event: Decodable, Sendable {
        let type: String
        let offset: Int?
        let endOffset: Int?
        let oldestOffset: Int?
        let nextOffset: Int?
        let data: String?
        let truncatedBefore: Bool?
        let message: String?
    }
    let id: String
    let event: Event
}

/// A bounded native VT text surface. Handles cursor motion, erasure, CR and backspace across
/// frame boundaries; escape/OSC data never appears as executable markup or terminal controls.
struct TerminalBuffer {
    private(set) var lines: [[Character]] = [[]]
    private var row = 0
    private var column = 0
    private var escape = ""
    private var mode = 0
    let columns: Int
    let rows: Int
    let limit: Int
    init(columns: Int = 80, rows: Int = 24, limit: Int = 1000) { self.columns = columns; self.rows = rows; self.limit = limit }
    mutating func resetParser() { mode = 0; escape = "" }
    var text: String { lines.map { String($0) }.joined(separator: "\n") }
    mutating func feed(_ text: String) {
        for char in text {
            if mode == 3 {
                if char == "\u{7}" || (escape == "\u{1b}" && char == "\\") { mode = 0; escape = "" }
                else { escape = char == "\u{1b}" ? String(char) : "" }
                continue
            }
            if mode == 1 {
                if char == "[" { mode = 2; escape = "" }
                else if char == "]" { mode = 3; escape = "" }
                else { mode = 0 }
                continue
            }
            if mode == 2 {
                if char.isLetter || char == "@" || char == "~" { csi(char); mode = 0; escape = "" }
                else if escape.count < 128 { escape.append(char) }
                else { mode = 0; escape = "" }
                continue
            }
            switch char {
            case "\u{1b}": mode = 1
            case "\r\n": column = 0; newline()
            case "\r": column = 0
            case "\n": newline()
            case "\u{8}": column = max(0, column - 1)
            case "\t": column = min(columns - 1, (column / 8 + 1) * 8)
            default:
                guard char.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }) else { continue }
                if column >= columns { column = 0; newline() }
                while lines[row].count <= column { lines[row].append(" ") }
                // A malicious combining sequence must not turn one bounded cell into megabytes.
                lines[row][column] = String(char).utf16.count <= 64 ? char : "�"; column += 1
            }
        }
    }
    private mutating func newline() {
        row += 1
        if row >= lines.count { lines.append([]) }
        if lines.count > limit { lines.removeFirst(); row -= 1 }
    }
    private mutating func csi(_ final: Character) {
        let values = escape.split(separator: ";", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
        let n = min(max(columns, rows), max(1, values.first ?? 1))
        let top = max(0, lines.count - rows)
        switch final {
        case "A": row = max(top, row - n)
        case "B": row = min(lines.count - 1, row + n)
        case "C": column = min(columns - 1, column + n)
        case "D": column = max(0, column - n)
        case "G": column = min(columns - 1, n - 1)
        case "H", "f":
            row = min(top + rows - 1, top + n - 1)
            while lines.count <= row { lines.append([]) }
            column = min(columns - 1, max(1, values.count > 1 ? values[1] : 1) - 1)
        case "K":
            let erase = values.first ?? 0
            if erase == 2 { lines[row] = [] }
            else if erase == 0 { lines[row] = Array(lines[row].prefix(column)) }
            else { for index in 0..<min(column + 1, lines[row].count) { lines[row][index] = " " } }
        case "J":
            if values.first == 2 || values.first == 3 { lines = [[]]; row = 0; column = 0 }
            else if values.first == 0 {
                lines[row] = Array(lines[row].prefix(column)); lines = Array(lines.prefix(row + 1))
            }
        default: break
        }
    }
}

@MainActor @Observable final class TerminalScreenModel {
    var streamId: String?
    var text = ""
    var offset = 0
    var problem: String?
    var exited = false
    @ObservationIgnored private var buffer = TerminalBuffer()
    func start(_ id: String) { streamId = id; offset = 0; text = ""; buffer = TerminalBuffer(); problem = nil; exited = false }
    func receive(_ patch: TerminalOutputPatch) -> Int? {
        guard patch.id == streamId else { return nil }
        let event = patch.event
        switch event.type {
        case "data":
            problem = nil
            guard let start = event.offset, let end = event.endOffset, let data = event.data else { return nil }
            if end > offset {
                if event.truncatedBefore == true || start > offset {
                    buffer.resetParser()
                    buffer.feed("\r\n[Earlier output unavailable]\r\n")
                }
                // Duplicate frames on reconnect are discarded by canonical PTY byte offsets.
                if start >= offset { buffer.feed(data) }
                else {
                    let bytes = Array(data.utf8.dropFirst(offset - start))
                    buffer.feed(String(decoding: bytes, as: UTF8.self))
                }
                offset = end; text = buffer.text
            }
        case "resync":
            if let oldest = event.oldestOffset, oldest > offset {
                buffer.resetParser()
                buffer.feed("\r\n[Earlier output unavailable]\r\n")
                offset = oldest; text = buffer.text
            }
        case "exit": exited = true
        case "problem": problem = event.message
        default: break
        }
        return offset
    }
}
