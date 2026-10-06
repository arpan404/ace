import Foundation
import ApplicationServices
import AppKit

struct Target: Codable, Equatable {
    let kind: String
    let bundleId: String?
    let bundleIds: [String]?
    let displayId: UInt32?
    let windowId: UInt32?
}
enum InputCoordinates { case pixels, windowPoints }
struct Action: Decodable {
    // These trusted routing fields are intentionally excluded from the JSON decoder.
    var coordinates: InputCoordinates = .pixels
    /// Focus the target window first when another window of its app holds focus.
    var focusFirst = true
    enum CodingKeys: String, CodingKey { case kind, x, y, button, text, keyCode, windowId, modifiers, deltaX, deltaY }
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
    let durationMs: Int?
    let key: String?
    let modifiers: [String]?
    let text: String?
    let dx: Int32?
    let dy: Int32?
}
struct UIQuery: Codable { let role: String?; let name: String?; let text: String? }
struct StreamSettings: Decodable {
    let codec: String
    let maxWidth: Int
    let maxHeight: Int
    let fps: Int
    let bitrate: Int
}
struct Request: Decodable {
    let version: Int
    let id: String
    let op: String
    let sessionId: String?
    var target: Target?
    var allowlist: [String]?
    let fps: Int?
    let settings: StreamSettings?
    let action: Action?
    let input: Input?
    let enabled: Bool?
    let capture: Bool?
    var maxDepth: Int?
    var maxNodes: Int?
    let query: UIQuery?
    let limit: Int?
    let ref: String?
    let value: String?
    let booleanValue: Bool?
    let scrollValue: ScrollValue?
    struct ScrollValue: Decodable { let dx: Int32; let dy: Int32 }
    let permission: String?
    let name: String?
    // ui.act's action is a string; decode it separately from v1's action object.
    let semanticAction: String?
    let mode: String?
    let secureInputAllowed: Bool?
    let humanDeviceInput: Bool?
    let bundleId: String?
    let range: TextRange?
    struct TextRange: Decodable { let location: Int; let length: Int }
    enum CodingKeys: String, CodingKey { case settings, version, id, op, sessionId, target, allowlist, fps, action, input, enabled, capture, maxDepth, maxNodes, query, limit, ref, value, permission, name, mode, secureInputAllowed, humanDeviceInput, bundleId, range }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version); id = try c.decode(String.self, forKey: .id); op = try c.decode(String.self, forKey: .op)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId); target = try c.decodeIfPresent(Target.self, forKey: .target)
        allowlist = try c.decodeIfPresent([String].self, forKey: .allowlist); fps = try c.decodeIfPresent(Int.self, forKey: .fps)
        settings = try c.decodeIfPresent(StreamSettings.self, forKey: .settings)
        action = op == "ui.act" ? nil : try c.decodeIfPresent(Action.self, forKey: .action)
        semanticAction = op == "ui.act" ? try c.decodeIfPresent(String.self, forKey: .action) : nil
        input = try c.decodeIfPresent(Input.self, forKey: .input); enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled)
        capture = try c.decodeIfPresent(Bool.self, forKey: .capture); maxDepth = try c.decodeIfPresent(Int.self, forKey: .maxDepth)
        maxNodes = try c.decodeIfPresent(Int.self, forKey: .maxNodes); query = try c.decodeIfPresent(UIQuery.self, forKey: .query)
        limit = try c.decodeIfPresent(Int.self, forKey: .limit); ref = try c.decodeIfPresent(String.self, forKey: .ref); value = try? c.decode(String.self, forKey: .value)
        booleanValue = try? c.decode(Bool.self, forKey: .value)
        scrollValue = try? c.decode(ScrollValue.self, forKey: .value)
        mode = try c.decodeIfPresent(String.self, forKey: .mode)
        secureInputAllowed = try c.decodeIfPresent(Bool.self, forKey: .secureInputAllowed)
        humanDeviceInput = try c.decodeIfPresent(Bool.self, forKey: .humanDeviceInput)
        bundleId = try c.decodeIfPresent(String.self, forKey: .bundleId)
        range = try c.decodeIfPresent(TextRange.self, forKey: .range)
        permission = try c.decodeIfPresent(String.self, forKey: .permission); name = try c.decodeIfPresent(String.self, forKey: .name)
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
/// A person asked for this permission: show macOS's prompt (only the first time it ever asks),
/// then open its Privacy & Security pane so the helper's switch is one click away.
@MainActor func requestPermission(_ permission: String) throws {
    let pane: String
    switch permission {
    case "screenRecording":
        if CGPreflightScreenCaptureAccess() { return }
        _ = CGRequestScreenCaptureAccess()
        pane = "Privacy_ScreenCapture"
    case "accessibility":
        if AXIsProcessTrusted() { return }
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        pane = "Privacy_Accessibility"
    default: throw HelperError("Unknown permission", code: "bounds")
    }
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
}
func capabilities() -> [String: Any] {
    ["version": 2, "platform": "macos", "background": true, "maxSessions": 8, "capture": ["windows": true, "displays": true, "changeDriven": true],
     "input": ["pointer": true, "keyboard": true, "scroll": true, "text": true], "uiTree": true,
     "semanticActions": ["press", "focus", "setValue", "scroll", "expand", "select", "performSecondaryAction", "selectText"], "codecs": ["jpeg", "h264"],
     "permissions": ["screen": CGPreflightScreenCaptureAccess() ? "granted" : "denied", "input": AXIsProcessTrusted() ? "granted" : "denied"]]
}
