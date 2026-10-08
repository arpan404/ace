import ApplicationServices
import CoreGraphics
import Foundation
import AppKit

func windowKeyEvent(_ kind: NSEvent.EventType, windowId: UInt32, character: String,
                    keyCode: UInt16, modifiers: NSEvent.ModifierFlags, timestamp: Double) throws -> CGEvent {
    guard let event = NSEvent.keyEvent(with: kind, location: .zero, modifierFlags: modifiers,
        timestamp: timestamp, windowNumber: Int(windowId), context: nil,
        characters: character, charactersIgnoringModifiers: character,
        isARepeat: false, keyCode: keyCode)?.cgEvent else { throw HelperError("Cannot create keyboard event") }
    return event
}

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

struct DestinationState: Equatable {
    let count: Int?
    let selection: CFRange?
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.count == rhs.count && lhs.selection?.location == rhs.selection?.location && lhs.selection?.length == rhs.selection?.length
    }
}
func destinationState(_ element: AXUIElement) -> DestinationState {
    let count = (axAttribute(element, kAXNumberOfCharactersAttribute) as? NSNumber)?.intValue
    var range: CFRange?
    if let value = axAttribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() {
        var decoded = CFRange()
        if AXValueGetValue(value as! AXValue, .cfRange, &decoded) { range = decoded }
    }
    return DestinationState(count: count, selection: range)
}

func verifyKeyboardDestination(expectedPID: pid_t, expectedWindow: UInt32, actualPID: pid_t?, actualWindow: UInt32?) throws {
    guard actualPID == expectedPID, actualWindow == expectedWindow else { throw HelperError("Actual keyboard app/window differs from the approved destination", code: "no_key_window") }
}
