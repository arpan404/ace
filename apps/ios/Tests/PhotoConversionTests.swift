import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import Ace

/// Pictures from Photos reach the agent in a type it sees as a picture.
@Suite struct PhotoConversionTests {
    /// A `width`×`height` picture encoded as `type`, stored with EXIF `orientation`.
    private func picture(_ type: UTType, width: Int, height: Int, orientation: Int = 1) throws -> Data {
        let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(red: 1, green: 0.3, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }
    private func size(_ data: Data) throws -> (Int, Int) {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        return (properties[kCGImagePropertyPixelWidth] as? Int ?? 0, properties[kCGImagePropertyPixelHeight] as? Int ?? 0)
    }

    @Test func aPNGGoesAsItIs() throws {
        let png = try picture(.png, width: 40, height: 20)
        let result = try #require(PhotoConversion.readable(png, type: .png))
        #expect(result.data == png)
        #expect(result.mimeType == "image/png")
    }

    @Test func aTypeAgentsDontSeeBecomesAJPEGTurnedUpright() throws {
        // A TIFF stands in for HEIC: both are kept by the daemon as opaque files. Orientation 6
        // means the stored 40×20 pixels show rotated, 20 wide and 40 tall.
        let tiff = try picture(.tiff, width: 40, height: 20, orientation: 6)
        let result = try #require(PhotoConversion.readable(tiff, type: .tiff))
        #expect(result.mimeType == "image/jpeg")
        #expect(result.fileExtension == "jpg")
        let (width, height) = try size(result.data)
        #expect(width == 20 && height == 40)
    }

    @Test func bytesThatArentAPictureAreRefused() {
        #expect(PhotoConversion.readable(Data("not a picture".utf8), type: .heic) == nil)
    }

    @Test func aVideosLengthReadsAsAClock() {
        #expect(VideoPreview.length(7) == "0:07")
        #expect(VideoPreview.length(3723) == "1:02:03")
    }
}
