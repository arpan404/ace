import Foundation
import IOKit

/// `ace-screen-helper --sim-posture <udid> --check` and
/// `ace-screen-helper --sim-posture <udid> --from <degrees> --to <degrees>`: folds a foldable
/// iOS Simulator (the iPhone Duo) by moving its hinge, the way Xcode's device tool does.
///
/// The simulator's HID daemon serves `com.apple.coredevice.feature.remote.hid.vendordefined`
/// (`SimHIDService`). One vendor-defined HID event (usage page 0xFF61, usage 0x5B)
/// carries a binary IOKit-serialized dictionary naming the hinge control and its angle in degrees
/// (0 closed, 180 flat). The service is private and may change with any Xcode release, so every
/// step is looked up at run time and a missing one reports `unavailable` instead of failing loudly.
///
/// Output is one JSON line: `{"available":true}`, `{"done":true}` or `{"unavailable":"…"}`
/// (exit 3). The angle sweeps with an ease-out and then holds, since the system follows the hinge
/// as a motion and settles on the last reading.
enum SimPosture {
    private static let service = "com.apple.coredevice.feature.remote.hid.vendordefined"

    static func run(arguments: [String]) -> Never {
        guard let index = arguments.firstIndex(of: "--sim-posture"), index + 1 < arguments.count,
              let udid = UUID(uuidString: arguments[index + 1]) else { finish(unavailable: "usage") }
        let check = arguments.contains("--check")
        let from = number(after: "--from", in: arguments)
        let to = number(after: "--to", in: arguments)
        if !check && to == nil { finish(unavailable: "usage") }
        let connection: xpc_connection_t
        switch SimHIDService.connect(udid, service: service) {
        case .failure(let reason): finish(unavailable: reason.text)
        case .success(let value): connection = value
        }
        if check {
            xpc_connection_cancel(connection)
            emit(["available": true])
            exit(0)
        }
        let target = clamp(to ?? 0)
        let start = clamp(from ?? target)
        let steps = 36
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            let eased = 1 - pow(1 - t, 3)
            guard send(angle: start + (target - start) * eased, on: connection) else {
                finish(unavailable: "serialize")
            }
            usleep(16_000)
        }
        for _ in 0..<20 {
            _ = send(angle: target, on: connection)
            usleep(30_000)
        }
        SimHIDService.flush(connection)
        xpc_connection_cancel(connection)
        emit(["done": true])
        exit(0)
    }

    private static func send(angle: Double, on connection: xpc_connection_t) -> Bool {
        let control: NSDictionary = [
            "provider": "com.apple.Virtualization.VirtualMachines",
            "source": "hinge-slider-control",
            "type": "range",
            "value": NSNumber(value: angle),
        ]
        guard let data = IOCFSerialize(control, CFOptionFlags(kIOCFSerializeToBinary)) as Data?
        else { return false }
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_uint64(payload, "usagePage", 0xFF61)
        xpc_dictionary_set_uint64(payload, "usage", 0x5B)
        xpc_dictionary_set_uint64(payload, "version", 0)
        data.withUnsafeBytes { bytes in
            xpc_dictionary_set_data(payload, "data", bytes.baseAddress!, bytes.count)
        }
        xpc_connection_send_message(connection, SimHIDService.message(type: "IndigoVendorDefinedEvent", payload: payload, service: service))
        return true
    }

    private static func number(after flag: String, in arguments: [String]) -> Double? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return Double(arguments[index + 1])
    }

    private static func clamp(_ angle: Double) -> Double { min(180, max(0, angle.isFinite ? angle : 0)) }

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
