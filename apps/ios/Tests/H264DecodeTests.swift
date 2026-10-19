import CoreMedia
import CoreVideo
import Foundation
import Testing
import VideoToolbox
@testable import Ace

/// Real H.264 through VideoToolbox: chunks in the daemon's AVC format (an `avcC` description on
/// the keyframe, length-prefixed NAL units) decode into pictures at their coded size.
@Suite struct H264DecodeTests {
    @Test func aKeyframeAndTheDeltaAfterItDecodeAtTheirCodedSize() throws {
        let (description, chunks) = try Self.encode(width: 320, height: 240, frames: 2)
        let decoder = try H264Decoder(config: VideoDecoderConfig(codec: "avc1.42E033", codedWidth: 320, codedHeight: 240, description: description))
        for chunk in chunks {
            let picture = try decoder.decode(chunk)
            #expect(CVPixelBufferGetWidth(picture) == 320)
            #expect(CVPixelBufferGetHeight(picture) == 240)
            #expect(H264Decoder.displayBuffer(picture) != nil)
        }
    }

    @Test func aDecoderNeedsAnH264Description() {
        #expect(throws: H264Decoder.DecodeError.self) {
            try H264Decoder(config: VideoDecoderConfig(codec: "vp8", codedWidth: 320, codedHeight: 240, description: nil))
        }
    }

    /// Encodes `frames` grey frames with VideoToolbox (the first a keyframe): the `avcC` record
    /// and each frame's AVC-format bytes, as the daemon's encoder sends them.
    static func encode(width: Int, height: Int, frames: Int) throws -> (Data, [Data]) {
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
                                                encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                                outputCallback: nil, refcon: nil, compressionSessionOut: &created)
        let session = try #require(created, "encoder \(status)")
        defer { VTCompressionSessionInvalidate(session) }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        let output = EncodedFrames()
        for index in 0..<frames {
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &buffer)
            let pixels = try #require(buffer)
            CVPixelBufferLockBaseAddress(pixels, [])
            for plane in 0..<CVPixelBufferGetPlaneCount(pixels) {
                memset(CVPixelBufferGetBaseAddressOfPlane(pixels, plane), Int32(100 + index * 20),
                       CVPixelBufferGetBytesPerRowOfPlane(pixels, plane) * CVPixelBufferGetHeightOfPlane(pixels, plane))
            }
            CVPixelBufferUnlockBaseAddress(pixels, [])
            let properties = index == 0 ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
            VTCompressionSessionEncodeFrame(session, imageBuffer: pixels, presentationTimeStamp: CMTime(value: Int64(index), timescale: 30),
                                            duration: .invalid, frameProperties: properties, infoFlagsOut: nil) { _, _, sample in
                output.add(sample)
            }
        }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        let samples = output.samples
        #expect(samples.count == frames)
        let format = try #require(samples.first.flatMap { CMSampleBufferGetFormatDescription($0) })
        let atoms = try #require(CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any])
        let avcC = try #require(atoms["avcC"] as? Data)
        let chunks = try samples.map { sample -> Data in
            let block = try #require(CMSampleBufferGetDataBuffer(sample))
            var data = Data(count: CMBlockBufferGetDataLength(block))
            _ = data.withUnsafeMutableBytes { raw in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: raw.count, destination: raw.baseAddress!)
            }
            return data
        }
        return (avcC, chunks)
    }
}

private final class EncodedFrames: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [CMSampleBuffer] = []
    var samples: [CMSampleBuffer] { lock.withLock { stored } }
    func add(_ sample: CMSampleBuffer?) {
        guard let sample else { return }
        lock.withLock { stored.append(sample) }
    }
}
