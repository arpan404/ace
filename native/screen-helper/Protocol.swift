import Foundation
import ApplicationServices

struct Target: Codable, Equatable {
    let kind: String
    let bundleId: String?
    let bundleIds: [String]?
    let displayId: UInt32?
    let windowId: UInt32?
}
struct Action: Decodable {
    var kind: String
    var x: Double? = nil
    var y: Double? = nil
    var button: String? = nil
    var text: String? = nil
    var keyCode: UInt16? = nil
    var windowId: UInt32? = nil
    var modifiers: [String]? = nil
    var deltaX: Int32? = nil
    var deltaY: Int32? = nil
}
struct Input: Decodable {
    let kind: String
    let x: Double?
    let y: Double?
    let toX: Double?
    let toY: Double?
    let button: String?
    let key: String?
    let modifiers: [String]?
    let text: String?
    let dx: Int32?
    let dy: Int32?
}
struct UIQuery: Codable { let role: String?; let name: String?; let text: String? }
struct Request: Decodable {
    let version: Int
    let id: String
    let op: String
    let sessionId: String?
    let target: Target?
    let allowlist: [String]?
    let fps: Int?
    let action: Action?
    let input: Input?
    let enabled: Bool?
    let capture: Bool?
    let maxDepth: Int?
    let maxNodes: Int?
    let query: UIQuery?
    let limit: Int?
    let ref: String?
    let value: String?
    // ui.act's action is a string; decode it separately from v1's action object.
    let semanticAction: String?
    enum CodingKeys: String, CodingKey { case version, id, op, sessionId, target, allowlist, fps, action, input, enabled, capture, maxDepth, maxNodes, query, limit, ref, value }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version); id = try c.decode(String.self, forKey: .id); op = try c.decode(String.self, forKey: .op)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId); target = try c.decodeIfPresent(Target.self, forKey: .target)
        allowlist = try c.decodeIfPresent([String].self, forKey: .allowlist); fps = try c.decodeIfPresent(Int.self, forKey: .fps)
        action = op == "ui.act" ? nil : try c.decodeIfPresent(Action.self, forKey: .action)
        semanticAction = op == "ui.act" ? try c.decodeIfPresent(String.self, forKey: .action) : nil
        input = try c.decodeIfPresent(Input.self, forKey: .input); enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled)
        capture = try c.decodeIfPresent(Bool.self, forKey: .capture); maxDepth = try c.decodeIfPresent(Int.self, forKey: .maxDepth)
        maxNodes = try c.decodeIfPresent(Int.self, forKey: .maxNodes); query = try c.decodeIfPresent(UIQuery.self, forKey: .query)
        limit = try c.decodeIfPresent(Int.self, forKey: .limit); ref = try c.decodeIfPresent(String.self, forKey: .ref); value = try c.decodeIfPresent(String.self, forKey: .value)
    }
}
struct HelperError: Error, CustomStringConvertible {
    let description: String
    let code: String
    init(_ message: String, code: String = "internal") { description = message; self.code = code }
}
func reply(_ request: Request, data: Any? = nil, error: Error? = nil) {
    var object: [String: Any] = ["version": request.version, "id": request.id, "ok": error == nil]
    if let data { object["data"] = data }
    if let error {
        let message = String(String(describing: error).prefix(1024))
        object["error"] = request.version == 1 ? message : ["code": (error as? HelperError)?.code ?? "internal", "message": message]
    }
    if let bytes = try? JSONSerialization.data(withJSONObject: object), bytes.count <= 64 * 1024 {
        FileHandle.standardOutput.write(bytes + Data([10]))
    } else if error == nil { reply(request, error: HelperError("Helper response exceeds limit", code: "busy")) }
}
func reply<T: Encodable>(_ request: Request, encoded data: T) throws {
    let bytes = try JSONEncoder().encode(data)
    reply(request, data: try JSONSerialization.jsonObject(with: bytes))
}
func permissions() -> [String: Bool] { ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()] }
func capabilities() -> [String: Any] {
    ["version": 2, "platform": "macos", "capture": ["windows": true, "displays": true, "changeDriven": true],
     "input": ["pointer": true, "keyboard": true, "scroll": true, "text": true], "uiTree": true,
     "semanticActions": ["press", "focus", "setValue", "scroll", "expand", "select"], "codecs": ["jpeg"],
     "permissions": ["screen": CGPreflightScreenCaptureAccess() ? "granted" : "denied", "input": AXIsProcessTrusted() ? "granted" : "denied"]]
}
