import Foundation

/// A connection to one of the HID services a booted iOS Simulator's HID daemon (dtuhidd, Xcode 27
/// and later) serves inside its own launchd namespace: `com.apple.coredevice.feature.remote.hid.*`.
/// Xcode's device tool reaches the simulator's touch screen, buttons and hinge through these.
///
/// The services are private and may change with any Xcode release, so every step is looked up
/// at run time and a missing one is reported as a reason, never a crash.
enum SimHIDService {
    struct Failure: Error { let text: String }

    private typealias EndpointFromPort = @convention(c) (mach_port_t) -> xpc_endpoint_t?
    private typealias EnableSimToHost = @convention(c) (xpc_connection_t) -> Void
    private typealias Lookup = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> mach_port_t

    /// An active connection to `service` in the booted simulator `udid`. `events` sees the
    /// connection's errors (the daemon restarting, the simulator shutting down).
    static func connect(_ udid: UUID, service: String, events: @escaping (xpc_object_t) -> Void = { _ in }) -> Result<xpc_connection_t, Failure> {
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
        guard port != 0 else { return .failure(Failure(text: "the simulator has no \(service.split(separator: ".").last ?? "") service")) }
        guard let endpoint = endpointFromPort(port) else { return .failure(Failure(text: "no endpoint")) }
        let connection = xpc_connection_create_from_endpoint(endpoint)
        xpc_connection_set_event_handler(connection, events)
        enableSimToHost(connection)
        xpc_connection_activate(connection)
        return .success(connection)
    }

    /// One event for the service, as Xcode's device tool frames it.
    static func message(type: String, payload: xpc_object_t, service: String) -> xpc_object_t {
        let message = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_string(message, "messageType", type)
        xpc_dictionary_set_value(message, "payload", payload)
        xpc_dictionary_set_string(message, "featureIdentifier", service)
        return message
    }

    /// Waits until everything sent on `connection` has been delivered, up to five seconds.
    static func flush(_ connection: xpc_connection_t) {
        let flushed = DispatchSemaphore(value: 0)
        xpc_connection_send_barrier(connection) { flushed.signal() }
        _ = flushed.wait(timeout: .now() + 5)
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
}
