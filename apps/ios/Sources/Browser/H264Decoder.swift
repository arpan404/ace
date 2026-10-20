import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Hardware H.264 decoding (VideoToolbox) of the daemon's chunks: the browser's AVC format
/// (length-prefixed NAL units, configured from a keyframe's `avcC`), or a device's Annex B
/// (configured from the parameter sets in front of its keyframe, ADR 0064). Each chunk decodes
/// synchronously into a pixel buffer at its coded size. Confined to the renderer's queue.
final class H264Decoder {
    enum DecodeError: Error { case unsupported, format(OSStatus), session(OSStatus), sample(OSStatus), decode(OSStatus), noPicture }

    private let format: CMVideoFormatDescription
    private let session: VTDecompressionSession
    /// The sequence then picture parameter sets this decoder was configured with: a keyframe
    /// carrying others (a new capture size or rotation) needs a new decoder.
    let parameterSets: [Data]

    /// A browser video decoder, configured from a keyframe's `avcC`.
    convenience init(config: VideoDecoderConfig) throws {
        guard config.codec.hasPrefix("avc1"), let record = config.description,
              let avc = try? AVCDescription(record) else { throw DecodeError.unsupported }
        try self.init(sequenceParameterSets: avc.sequenceParameterSets, pictureParameterSets: avc.pictureParameterSets,
                      nalLengthSize: avc.nalLengthSize)
    }

    /// A device picture decoder, configured from the parameter sets in front of an Annex B
    /// keyframe; its pictures then go through `decode(annexB:)`.
    convenience init(annexBKeyframe keyframe: Data) throws {
        guard let sets = AnnexB.parameterSets(keyframe) else { throw DecodeError.unsupported }
        try self.init(sequenceParameterSets: sets.sequence, pictureParameterSets: sets.picture, nalLengthSize: 4)
    }

    init(sequenceParameterSets: [Data], pictureParameterSets: [Data], nalLengthSize: Int) throws {
        guard !sequenceParameterSets.isEmpty, !pictureParameterSets.isEmpty else { throw DecodeError.unsupported }
        parameterSets = sequenceParameterSets + pictureParameterSets
        let sets = parameterSets.map { [UInt8]($0) }
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
            nalUnitHeaderLength: Int32(nalLengthSize), formatDescriptionOut: &described)
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

    /// One Annex B access unit's picture (a device's H.264); its parameter sets are skipped.
    func decode(annexB bytes: Data) throws -> CVPixelBuffer { try decode(AnnexB.lengthPrefixed(bytes)) }

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
}

/// The synchronous decode's result, written by VideoToolbox's output handler before it returns.
private final class DecodedPicture: @unchecked Sendable {
    var status: OSStatus = noErr
    var image: CVImageBuffer?
}
