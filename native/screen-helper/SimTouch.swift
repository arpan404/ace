import Foundation

/// `ace-screen-helper --sim-touch <udid> [--check]`: touches a booted iOS Simulator through the
/// digitizer service its HID daemon serves (`SimHIDService`), the route Xcode's device tool
/// takes. On Xcode 27 the older SimulatorKit touch path can lose its service inside the
/// simulator and drop every touch; this one is what the system expects.
///
/// It prints one JSON line, `{"ready":true}` (or `{"available":true}` with `--check`), or
/// `{"unavailable":"…"}` and exits 3. It then reads one touch step per stdin line:
/// `{"phase":"down"|"move"|"up","x":0…1,"y":0…1,"x2":…,"y2":…,"edge":0…4,"target":n}`.
/// Points are normalized to the screen's portrait framebuffer; `x2`/`y2` add a second finger;
/// `edge` marks a system edge gesture (1 left, 2 top, 3 bottom, 4 right) and must stay on every
/// step of it; `target` names the display (0 the main one, else devicectl's display id).
/// End of input lifts a held finger and exits 0. A lost connection prints `{"error":"…"}` and
/// exits 4.
enum SimTouch {
    private static let service = "com.apple.coredevice.feature.remote.hid.digitizer"
    /// The event types the digitizer service decodes: a finger touching, moving, and lifting.
    private static let eventTypes: [String: UInt64] = ["down": 0, "move": 1, "up": 2]

    struct Step {
        let phase: String
        let x: Double, y: Double
        let second: (x: Double, y: Double)?
        let edge: UInt64
        let target: UInt64
    }

    static func run(arguments: [String]) -> Never {
        guard let index = arguments.firstIndex(of: "--sim-touch"), index + 1 < arguments.count,
              let udid = UUID(uuidString: arguments[index + 1]) else { finish(unavailable: "usage") }
        let connection: xpc_connection_t
        let closing = Closing()
        let events: (xpc_object_t) -> Void = { event in
            guard xpc_get_type(event) == XPC_TYPE_ERROR, !closing.value else { return }
            let text = xpc_dictionary_get_string(event, XPC_ERROR_KEY_DESCRIPTION).map { String(cString: $0) } ?? "connection lost"
            emit(["error": text])
            exit(4)
        }
        switch SimHIDService.connect(udid, service: service, events: events) {
        case .failure(let reason): finish(unavailable: reason.text)
        case .success(let value): connection = value
        }
        if arguments.contains("--check") {
            closing.value = true
            xpc_connection_cancel(connection)
            emit(["available": true])
            exit(0)
        }
        emit(["ready": true])
        var held: Step?
        while let line = readLine(strippingNewline: true) {
            guard let step = parse(line) else { continue }
            xpc_connection_send_message(connection, SimHIDService.message(type: "IndigoDigitizerEvent", payload: payload(step), service: service))
            held = step.phase == "up" ? nil : step
        }
        if let last = held {
            let lift = Step(phase: "up", x: last.x, y: last.y, second: last.second, edge: last.edge, target: last.target)
            xpc_connection_send_message(connection, SimHIDService.message(type: "IndigoDigitizerEvent", payload: payload(lift), service: service))
        }
        SimHIDService.flush(connection)
        closing.value = true
        xpc_connection_cancel(connection)
        exit(0)
    }

    /// Set before this side closes the connection, so the error that follows isn't a loss.
    private final class Closing: @unchecked Sendable {
        private let lock = NSLock()
        private var closed = false
        var value: Bool {
            get { lock.withLock { closed } }
            set { lock.withLock { closed = newValue } }
        }
    }

    /// A step from one input line, or nil when the line isn't one.
    static func parse(_ line: String) -> Step? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let phase = object["phase"] as? String, eventTypes[phase] != nil,
              let x = unit(object["x"]), let y = unit(object["y"]) else { return nil }
        let second: (x: Double, y: Double)?
        if let x2 = unit(object["x2"]), let y2 = unit(object["y2"]) { second = (x2, y2) } else { second = nil }
        let edge = (object["edge"] as? NSNumber).map { min(4, max(0, $0.intValue)) } ?? 0
        let target = (object["target"] as? NSNumber).map { min(64, max(0, $0.intValue)) } ?? 0
        return Step(phase: phase, x: x, y: y, second: second, edge: UInt64(edge), target: UInt64(target))
    }

    /// A coordinate in 0…1, or nil when the value isn't a finite number.
    private static func unit(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, number.doubleValue.isFinite else { return nil }
        return min(1, max(0, number.doubleValue))
    }

    /// The digitizer event, keyed as the service decodes it.
    private static func payload(_ step: Step) -> xpc_object_t {
        let point = { (x: Double, y: Double) -> xpc_object_t in
            let value = xpc_dictionary_create(nil, nil, 0)
            xpc_dictionary_set_double(value, "x", x)
            xpc_dictionary_set_double(value, "y", y)
            return value
        }
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_value(payload, "pointOne", point(step.x, step.y))
        if let second = step.second { xpc_dictionary_set_value(payload, "pointTwo", point(second.x, second.y)) }
        xpc_dictionary_set_uint64(payload, "eventType", eventTypes[step.phase] ?? 1)
        xpc_dictionary_set_uint64(payload, "edge", step.edge)
        xpc_dictionary_set_uint64(payload, "target", step.target)
        return payload
    }

    private static func emit(_ object: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: object) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
    }

    private static func finish(unavailable reason: String) -> Never {
        emit(["unavailable": reason])
        exit(3)
    }
}
