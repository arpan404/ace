import Foundation
import CoreGraphics

struct Target: Codable {
    let kind: String
    let bundleId: String?
    let bundleIds: [String]?
    let displayId: UInt32?
    let windowId: UInt32?
}
struct Action: Decodable {
    let kind: String
    let x: Double?
    let y: Double?
    let button: String?
    let text: String?
    let keyCode: UInt16?
    let modifiers: [String]?
    let deltaX: Int32?
    let deltaY: Int32?
}
struct Request: Decodable {
    let version: Int
    let id: String
    let op: String
    let sessionId: String?
    let target: Target?
    let allowlist: [String]?
    let fps: Int?
    let action: Action?
}
struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}
func reply(_ id: String, data: Any? = nil, error: String? = nil) {
    var object: [String: Any] = ["version": 1, "id": id, "ok": error == nil]
    if let data { object["data"] = data }
    if let error { object["error"] = String(error.prefix(1024)) }
    if let bytes = try? JSONSerialization.data(withJSONObject: object), bytes.count <= 64 * 1024 {
        FileHandle.standardOutput.write(bytes + Data([10]))
    } else if error == nil { reply(id, error: "Helper response exceeds limit") }
}
func permissions() -> [String: Bool] {
    ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
}
import ApplicationServices
