import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Hardware H.264 decoding (VideoToolbox) of the daemon's AVC-format chunks: length-prefixed NAL
/// units, configured from a keyframe's `avcC`. Each chunk decodes synchronously into a pixel
/// buffer at its coded size (the view's size times the screen's scale, ADR 0088). Confined to
/// the renderer's queue.
final class H264Decoder {
    enum DecodeError: Error { case unsupported, format(OSStatus), session(OSStatus), sample(OSStatus), decode(OSStatus), noPicture }

    private let format: CMVideoFormatDescription
    private let session: VTDecompressionSession

    init(config: VideoDecoderConfig) throws {
        guard config.codec.hasPrefix("avc1"), let record = config.description,
              let avc = try? AVCDescription(record) else { throw DecodeError.unsupported }
        let sets = (avc.sequenceParameterSets + avc.pictureParameterSets).map { [UInt8]($0) }
        let buffers = sets.map { bytes -> UnsafeMutablePointer<UInt8> in
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bytes.count)
            buffer.initialize(from: bytes, count: bytes.count)
            return buffer
        }
        defer { for buffer in buffers { buffer.deallocate() } }
        var described: CMFormatDescription?
        let made = CMVideoFormatDescriptionCreateFromH264ParameterSets(
            allocator: kCFAllocatorDefault, parameterSetCount: sets.count,
            parameterSetPointers: buffers.map { UnsafePointer($0) }, parameterSetSizes: sets.map(\.count),
            nalUnitHeaderLength: Int32(avc.nalLengthSize), formatDescriptionOut: &described)
        guard made == noErr, let described else { throw DecodeError.format(made) }
        format = described
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey: [CFString: Any](),
        ]
        var created: VTDecompressionSession?
        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault, formatDescription: described, decoderSpecification: nil,
            imageBufferAttributes: attributes as CFDictionary, outputCallback: nil, decompressionSessionOut: &created)
        guard status == noErr, let created else { throw DecodeError.session(status) }
        session = created
    }
    deinit { VTDecompressionSessionInvalidate(session) }

    /// One chunk's picture. Throws on a decode error; the renderer then asks for a keyframe.
    func decode(_ bytes: Data) throws -> CVPixelBuffer {
        var block: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes.count, blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil, offsetToData: 0, dataLength: bytes.count, flags: kCMBlockBufferAssureMemoryNowFlag,
            blockBufferOut: &block)
        guard status == noErr, let block else { throw DecodeError.sample(status) }
        status = bytes.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return OSStatus(kCMBlockBufferBadPointerParameterErr) }
            return CMBlockBufferReplaceDataBytes(with: base, blockBuffer: block, offsetIntoDestination: 0, dataLength: raw.count)
        }
        guard status == noErr else { throw DecodeError.sample(status) }
        var sample: CMSampleBuffer?
        var size = bytes.count
        status = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: 1,
            sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &size,
            sampleBufferOut: &sample)
        guard status == noErr, let sample else { throw DecodeError.sample(status) }
        let output = DecodedPicture()
        status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [], infoFlagsOut: nil) { result, _, image, _, _ in
            output.status = result
            output.image = image
        }
        guard status == noErr else { throw DecodeError.decode(status) }
        VTDecompressionSessionWaitForAsynchronousFrames(session)
        guard output.status == noErr else { throw DecodeError.decode(output.status) }
        guard let image = output.image else { throw DecodeError.noPicture }
        return image
    }

    /// A decoded picture as the display layer takes it, shown as soon as it is enqueued.
    static func displayBuffer(_ image: CVPixelBuffer) -> CMSampleBuffer? {
        var described: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image,
                                                           formatDescriptionOut: &described) == noErr, let described else { return nil }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
                                        decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: described,
                                                       sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let sample else { return nil }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
            let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dictionary, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        return sample
    }
}

/// The synchronous decode's result, written by VideoToolbox's output handler before it returns.
private final class DecodedPicture: @unchecked Sendable {
    var status: OSStatus = noErr
    var image: CVImageBuffer?
}
