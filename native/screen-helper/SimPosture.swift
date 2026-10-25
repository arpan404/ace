import Foundation
import IOKit

/// `ace-screen-helper --sim-posture <udid> --check` and
/// `ace-screen-helper --sim-posture <udid> --from <degrees> --to <degrees>`: folds a foldable
/// iOS Simulator (the iPhone Duo) by moving its hinge, the way Xcode's device tool does.
///
/// The simulator runs a HID daemon that serves `com.apple.coredevice.feature.remote.hid.vendordefined`
/// inside its own launchd namespace. One vendor-defined HID event (usage page 0xFF61, usage 0x5B)
/// carries a binary IOKit-serialized dictionary naming the hinge control and its angle in degrees
/// (0 closed, 180 flat). The service is private and may change with any Xcode release, so every
/// step is looked up at run time and a missing one reports `unavailable` instead of failing loudly.
///
/// Output is one JSON line: `{"available":true}`, `{"done":true}` or `{"unavailable":"…"}`
/// (exit 3). The angle sweeps with an ease-out and then holds, since the system follows the hinge
/// as a motion and settles on the last reading.
enum SimPosture {
    private static let service = "com.apple.coredevice.feature.remote.hid.vendordefined"
    private typealias EndpointFromPort = @convention(c) (mach_port_t) -> xpc_endpoint_t?
    private typealias EnableSimToHost = @convention(c) (xpc_connection_t) -> Void
    private typealias Lookup = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> mach_port_t

    static func run(arguments: [String]) -> Never {
        guard let index = arguments.firstIndex(of: "--sim-posture"), index + 1 < arguments.count,
              let udid = UUID(uuidString: arguments[index + 1]) else { finish(unavailable: "usage") }
        let check = arguments.contains("--check")
        let from = number(after: "--from", in: arguments)
        let to = number(after: "--to", in: arguments)
        if !check && to == nil { finish(unavailable: "usage") }
        let connection: xpc_connection_t
        switch connect(udid) {
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
        let flushed = DispatchSemaphore(value: 0)
        xpc_connection_send_barrier(connection) { flushed.signal() }
        _ = flushed.wait(timeout: .now() + 5)
        xpc_connection_cancel(connection)
        emit(["done": true])
        exit(0)
    }

    private struct Failure: Error { let text: String }

    private static func connect(_ udid: UUID) -> Result<xpc_connection_t, Failure> {
        guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil
        else { return .failure(Failure(text: "CoreSimulator is missing")) }
        guard let endpointSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "xpc_endpoint_create_mach_port_4sim"),
              let simToHostSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "xpc_connection_enable_sim2host_4sim")
        else { return .failure(Failure(text: "this macOS has no simulator XPC bridge")) }
        let endpointFromPort = unsafeBitCast(endpointSymbol, to: EndpointFromPort.self)
        let enableSimToHost = unsafeBitCast(simToHostSymbol, to: EnableSimToHost.self)
        guard let device = simulator(udid) else { return .failure(Failure(text: "simulator not found")) }
        let lookup = NSSelectorFromString("lookup:error:")
        guard device.responds(to: lookup), let method = class_getMethodImplementation(type(of: device), lookup)
        else { return .failure(Failure(text: "CoreSimulator has no service lookup")) }
        var error: NSError?
        let port = unsafeBitCast(method, to: Lookup.self)(device, lookup, service as NSString, &error)
        guard port != 0 else { return .failure(Failure(text: "the simulator has no hinge service")) }
        guard let endpoint = endpointFromPort(port) else { return .failure(Failure(text: "no endpoint")) }
        let connection = xpc_connection_create_from_endpoint(endpoint)
        xpc_connection_set_event_handler(connection) { _ in }
        enableSimToHost(connection)
        xpc_connection_activate(connection)
        return .success(connection)
    }

    /// The booted simulator with this UDID, from CoreSimulator's default device set.
    private static func simulator(_ udid: UUID) -> NSObject? {
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let shared = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        let deviceSet = NSSelectorFromString("defaultDeviceSetWithError:")
        typealias Shared = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> AnyObject?
        typealias SetOf = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>?) -> AnyObject?
        guard contextClass.responds(to: shared),
              let sharedIMP = class_getMethodImplementation(object_getClass(contextClass), shared) else { return nil }
        var error: NSError?
        guard let context = unsafeBitCast(sharedIMP, to: Shared.self)(contextClass, shared, developerDirectory() as NSString, &error) as? NSObject,
              context.responds(to: deviceSet),
              let setIMP = class_getMethodImplementation(type(of: context), deviceSet),
              let set = unsafeBitCast(setIMP, to: SetOf.self)(context, deviceSet, &error) as? NSObject,
              let devices = set.value(forKey: "devicesByUDID") as? NSDictionary
        else { return nil }
        return devices.object(forKey: udid as NSUUID) as? NSObject
    }

    /// The selected Xcode, as `xcode-select` would report it, without spawning a process.
    private static func developerDirectory() -> String {
        if let path = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !path.isEmpty { return path }
        if let link = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var/db/xcode_select_link") { return link }
        return "/Applications/Xcode.app/Contents/Developer"
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
        let message = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_string(message, "messageType", "IndigoVendorDefinedEvent")
        xpc_dictionary_set_value(message, "payload", payload)
        xpc_dictionary_set_string(message, "featureIdentifier", service)
        xpc_connection_send_message(connection, message)
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
