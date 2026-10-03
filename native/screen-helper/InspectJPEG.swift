import AppKit
// Integration-only decoder: inspect real pixels from the helper's JPEG stream.
@main struct InspectJPEG {
    static func main() throws {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let image = NSBitmapImageRep(data: data) else { throw NSError(domain: "Invalid JPEG", code: 1) }
        var red = 0; var blue = 0; var samples = 0
        for y in stride(from: 0, to: image.pixelsHigh, by: 4) {
            for x in stride(from: 0, to: image.pixelsWide, by: 4) {
                guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                samples += 1
                if color.redComponent > 0.7 && color.greenComponent < 0.4 && color.blueComponent < 0.2 { red += 1 }
                if color.blueComponent > 0.7 && color.redComponent < 0.2 && color.greenComponent < 0.4 { blue += 1 }
            }
        }
        print("{\"red\":\(red),\"blue\":\(blue),\"samples\":\(samples)}")
    }
}
