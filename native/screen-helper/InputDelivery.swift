import CoreGraphics
import Foundation

/// The posting destination is a policy decision. Only the I/O adapter calls the platform API.
enum EventDestination: Equatable { case process(pid_t), foreground }
func inputDestination(mode: String, pid: pid_t) throws -> EventDestination {
    guard pid > 0 else { throw HelperError("Invalid process target", code: "target_gone") }
    if mode == "background" { return .process(pid) }
    if mode == "foreground" { return .foreground }
    throw HelperError("Invalid input mode", code: "permission_denied")
}
func deliverInput(_ event: CGEvent, mode: String, pid: pid_t, permission: () -> Bool, post: (CGEvent, EventDestination) throws -> Void) throws {
    try NativeInputPost.perform(permission: permission) { try post(event, inputDestination(mode: mode, pid: pid)) }
}
