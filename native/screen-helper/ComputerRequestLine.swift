import Foundation

/// One line cut from stdin. An over-long line keeps only its start, enough to find its id.
enum CUFramedLine: Equatable {
    case line(Data)
    case overlong(prefix: Data)
}

/// Splits stdin bytes into lines. A line longer than `limit` is never buffered whole: its
/// first bytes are kept, the rest is discarded up to the next newline, and the reader carries
/// on with the following request.
struct CULineFramer {
    let limit: Int
    private let keep = 4_096
    private var pending = Data()
    private var overflowing = false

    init(limit: Int = 8 * 1024 * 1024) { self.limit = limit }

    mutating func feed<Bytes: Sequence>(_ bytes: Bytes) -> [CUFramedLine] where Bytes.Element == UInt8 {
        var lines: [CUFramedLine] = []
        for byte in bytes {
            if byte == 10 {
                lines.append(overflowing ? .overlong(prefix: pending) : .line(pending))
                pending.removeAll(keepingCapacity: !overflowing)
                overflowing = false
                continue
            }
            if overflowing { continue }
            pending.append(byte)
            if pending.count > limit {
                overflowing = true
                pending = pending.prefix(keep)
            }
        }
        return lines
    }
}

/// What one request line holds.
enum CURequestLine {
    case request(id: String, body: CUObject)
    /// Not a usable request; reply bad_request to `id` ("" when no id could be read).
    case invalid(id: String, message: String)
    /// Blank lines are ignored.
    case blank
}

func cuParseRequestLine(_ framed: CUFramedLine) -> CURequestLine {
    switch framed {
    case .overlong(let prefix):
        return .invalid(id: cuSniffRequestId(prefix) ?? "", message: "The request was longer than 8 MB and was discarded.")
    case .line(let data):
        if data.allSatisfy({ $0 == 32 || $0 == 9 || $0 == 13 }) { return .blank }
        guard let parsed = try? JSONSerialization.jsonObject(with: data), let body = parsed as? CUObject else {
            return .invalid(id: cuSniffRequestId(data) ?? "", message: "The request is not a JSON object.")
        }
        guard let id = body["id"] as? String else { return .invalid(id: "", message: "The request has no string id.") }
        guard body["op"] is String else { return .invalid(id: id, message: "The request has no op.") }
        return .request(id: id, body: body)
    }
}

/// Finds `"id":"…"` near the start of a line that could not be parsed whole.
func cuSniffRequestId(_ data: Data) -> String? {
    let text = String(decoding: data.prefix(4_096), as: UTF8.self)
    guard let key = text.range(of: "\"id\"") else { return nil }
    var rest = text[key.upperBound...].drop { $0 == " " || $0 == "\t" }
    guard rest.first == ":" else { return nil }
    rest = rest.dropFirst().drop { $0 == " " || $0 == "\t" }
    guard rest.first == "\"" else { return nil }
    rest = rest.dropFirst()
    guard let end = rest.firstIndex(where: { $0 == "\"" || $0 == "\\" }), rest[end] == "\"" else { return nil }
    return String(rest[..<end])
}
