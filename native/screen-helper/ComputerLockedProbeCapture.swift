import AppKit
import ScreenCaptureKit
import UniformTypeIdentifiers

// Screenshot checks of the locked-Mac probe: each capture path, with pixel statistics that tell
// real window content from a black frame or the lock screen, and a PNG for a person to look at.

/// Coarse statistics over a 64x64 downsample.
func cuProbePixelStats(_ image: CGImage) -> CUObject {
    let side = 64
    guard let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let data = context.data else { return [:] }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    let pixels = data.bindMemory(to: UInt8.self, capacity: side * side * 4)
    var sum = 0.0, squares = 0.0, dark = 0, transparent = 0
    var colours = Set<Int>()
    for index in 0..<(side * side) {
        let red = Double(pixels[index * 4]), green = Double(pixels[index * 4 + 1]), blue = Double(pixels[index * 4 + 2])
        let luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        sum += luminance
        squares += luminance * luminance
        if luminance < 16 { dark += 1 }
        if pixels[index * 4 + 3] < 8 { transparent += 1 }
        colours.insert((Int(pixels[index * 4]) >> 4) << 8 | (Int(pixels[index * 4 + 1]) >> 4) << 4 | Int(pixels[index * 4 + 2]) >> 4)
    }
    let count = Double(side * side), mean = sum / count
    return [
        "width": image.width, "height": image.height, "meanLuminance": (mean * 10).rounded() / 10,
        "stddevLuminance": ((max(0, squares / count - mean * mean)).squareRoot() * 10).rounded() / 10,
        "darkFraction": Double(dark) / count, "transparentFraction": Double(transparent) / count,
        "distinctColours": colours.count, "looksBlank": cuImageLooksBlank(image),
    ]
}

func cuProbeSavePNG(_ image: CGImage, name: String) -> String? {
    let path = "\(cuProbeImageDirectory)/\(name).png"
    guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination) ? path : nil
}

func cuProbeDescribe(_ image: CGImage?, name: String) -> CUObject {
    guard let image else { return ["captured": false] }
    var row = cuProbePixelStats(image)
    row["captured"] = true
    row["png"] = cuProbeSavePNG(image, name: name) ?? ""
    return row
}

/// The engine's own capture path, then ScreenCaptureKit alone, then the window server's last frame.
@available(macOS 14.0, *)
@MainActor func cuProbeCaptures(_ app: NSRunningApplication, window: AXUIElement?, name: String) async -> (Bool, CUObject) {
    guard let window, let number = cuWindowNumber(window), let frame = cuFrame(of: window) else { return (false, ["note": "no window"]) }
    var detail: CUObject = ["window": Int(number), "onScreen": cuServerWindowInfo([number])[number]?.onScreen ?? false, "onSomeSpace": cuWindowIsOnSomeSpace(number)]
    let engineStarted = cuNow()
    do {
        let shot = try await cuCaptureWindow(number, frame: frame)
        let image = NSBitmapImageRep(data: shot.jpeg)?.cgImage
        var row = cuProbeDescribe(image, name: "\(name)-engine")
        row["ms"] = cuMs(cuNow() - engineStarted)
        detail["engine"] = row
    } catch let fault as CUError {
        detail["engine"] = ["error": "\(fault.code): \(fault.message)", "ms": cuMs(cuNow() - engineStarted)]
    } catch {
        detail["engine"] = ["error": String(describing: error), "ms": cuMs(cuNow() - engineStarted)]
    }
    let width = max(1, Int(frame.width)), height = max(1, Int(frame.height))
    let sckStarted = cuNow()
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let target = content.windows.first(where: { $0.windowID == number }) else { throw CUError("window_gone", "not shareable") }
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: target), configuration: configuration)
        var row = cuProbeDescribe(image, name: "\(name)-sck")
        row["ms"] = cuMs(cuNow() - sckStarted)
        detail["screenCaptureKit"] = row
    } catch {
        detail["screenCaptureKit"] = ["error": cuProbeErrorText(error), "ms": cuMs(cuNow() - sckStarted)]
    }
    let lastStarted = cuNow()
    var last = cuProbeDescribe(cuLastFrame(number, width: width, height: height), name: "\(name)-windowlist")
    last["ms"] = cuMs(cuNow() - lastStarted)
    detail["windowListLastFrame"] = last
    let engine = detail["engine"] as? CUObject
    return ((engine?["captured"] as? Bool) == true && (engine?["looksBlank"] as? Bool) == false, detail)
}

/// The whole main display: shows whether captures see the lock screen instead of the desktop.
@available(macOS 14.0, *)
@MainActor func cuProbeDisplayCapture(name: String) async -> (Bool, CUObject) {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            return (false, ["note": "no display"])
        }
        let configuration = SCStreamConfiguration()
        configuration.width = display.width
        configuration.height = display.height
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration)
        var row = cuProbeDescribe(image, name: name)
        row["onScreenWindowOwners"] = Array(Set(content.windows.compactMap { $0.owningApplication?.bundleIdentifier })).sorted()
        return (true, row)
    } catch {
        return (false, ["error": cuProbeErrorText(error)])
    }
}

func cuProbeErrorText(_ error: Error) -> String {
    if let fault = error as? CUError { return "\(fault.code): \(fault.message)" }
    let ns = error as NSError
    return "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
}
