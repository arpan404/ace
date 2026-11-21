import XCTest
@testable import ScreenHelper

final class VideoCodecTests: XCTestCase {
    /// An SPS NAL: header, then the first byte (VPS id, sub-layers, nesting) and the profile, tier
    /// and level of `profile_tier_level`, as bytes after it.
    private func sps(_ ptl: [UInt8]) -> [UInt8] { [0x42, 0x01, 0x01] + ptl + [0xA0, 0x02, 0x80] }

    func testMainProfileSPSNamesItsProfileCompatibilityTierLevelAndConstraints() {
        // Main (1), compatible with Main and Main 10, Main tier, level 5.1 (153), progressive,
        // non-packed and frame-only constraints (0xB0).
        let main: [UInt8] = [0x01, 0x60, 0x00, 0x00, 0x00, 0xB0, 0, 0, 0, 0, 0, 153]
        XCTAssertEqual(hevcCodecString(sps: sps(main)), "hvc1.1.6.L153.B0")
    }

    func testHighTierProfileSpaceAndInnerConstraintBytesAreKept() {
        // Profile space 1 (A), High tier, Main 10 (2) compatible with Main 10 only, level 4 (120),
        // constraint bytes 0x90 0x00 0x10 then zeros (trailing zeros are left out).
        let ptl: [UInt8] = [0x62, 0x20, 0x00, 0x00, 0x00, 0x90, 0x00, 0x10, 0, 0, 0, 120]
        XCTAssertEqual(hevcCodecString(sps: sps(ptl)), "hvc1.A2.4.H120.90.0.10")
    }

    func testEmulationPreventionBytesAreRemovedBeforeTheProfileIsRead() {
        // 00 00 03 00 in the compatibility flags is 00 00 00 in the RBSP.
        let escaped: [UInt8] = [0x01, 0x00, 0x00, 0x03, 0x00, 0x02, 0xB0, 0, 0, 0, 0, 0, 93]
        XCTAssertEqual(hevcCodecString(sps: sps(escaped)), "hvc1.1.40000000.L93.B0")
    }

    func testANALThatIsNotAnSPSOrIsTooShortNamesNoCodec() {
        let main: [UInt8] = [0x01, 0x60, 0x00, 0x00, 0x00, 0xB0, 0, 0, 0, 0, 0, 153]
        XCTAssertNil(hevcCodecString(sps: [0x40, 0x01, 0x01] + main))
        XCTAssertNil(hevcCodecString(sps: Array(sps(main).prefix(10))))
    }

    func testAStreamConfiguredForHEVCEncodesHEVCOnlyWhileItGoesToIngest() {
        XCTAssertEqual(encodedCodec(configured: "hevc", ingesting: true), .hevc)
        XCTAssertEqual(encodedCodec(configured: "hevc", ingesting: false), .h264)
        XCTAssertEqual(encodedCodec(configured: "h264", ingesting: true), .h264)
    }

    func testHEVCAskedOfAHelperWithoutHardwareHEVCRunsAsH264() {
        XCTAssertEqual(streamCodec(requested: "hevc", hardwareHEVC: false), "h264")
        XCTAssertEqual(streamCodec(requested: "hevc", hardwareHEVC: true), "hevc")
        XCTAssertEqual(streamCodec(requested: "jpeg", hardwareHEVC: false), "jpeg")
    }

    func testIngestFramesCarryTheirEncodersCodecByte() {
        let unit = { (codec: VideoCodec) in
            EncodedVideo(keyframe: true, codec: codec.fallbackString, format: codec, width: 64, height: 64, scale: 1, sequence: 1,
                timestamp: 0, epoch: 0, capturedAt: 0, payloadBytes: 1, packet: { header in header + Data([0]) })
        }
        XCTAssertEqual(ingestFrame(unit(.hevc), now: 0)?[31], 3)
        XCTAssertEqual(ingestFrame(unit(.h264), now: 0)?[31], 1)
    }
}

import CoreVideo
import VideoToolbox

/// A real hardware HEVC encode on this Mac, decoded back. Skips where no hardware HEVC encoder exists.
final class HEVCEncodeTests: XCTestCase {
    /// Whether this Mac has a hardware HEVC encoder, asked of VideoToolbox apart from the encoder
    /// under test, so a broken encode fails instead of skipping.
    private func requireHardwareHEVC() throws {
        var properties: CFDictionary?
        let specification = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary
        let status = VTCopySupportedPropertyDictionaryForEncoder(width: 640, height: 360, codecType: kCMVideoCodecType_HEVC,
            encoderSpecification: specification, encoderIDOut: nil, supportedPropertiesOut: &properties)
        // Only "no such encoder" means the hardware is missing; any other error is a failure.
        if status == kVTCouldNotFindVideoEncoderErr { throw XCTSkip("No hardware HEVC encoder on this Mac") }
        XCTAssertEqual(status, noErr, "Asking VideoToolbox for a hardware HEVC encoder failed")
    }

    /// The NAL units of an Annex B payload with 4-byte start codes.
    private func nalUnits(_ payload: Data) -> [Data] {
        let bytes = [UInt8](payload)
        var starts: [Int] = []
        var index = 0
        while index + 4 <= bytes.count {
            if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 0, bytes[index + 3] == 1 { starts.append(index + 4); index += 4 } else { index += 1 }
        }
        return starts.enumerated().map { offset, start in
            let end = offset + 1 < starts.count ? starts[offset + 1] - 4 : bytes.count
            return Data(bytes[start..<end])
        }
    }

    private func picture() throws -> CVPixelBuffer {
        var picture: CVPixelBuffer?
        let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
        XCTAssertEqual(CVPixelBufferCreate(nil, 640, 360, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes as CFDictionary, &picture), kCVReturnSuccess)
        return try XCTUnwrap(picture)
    }

    func testAHardwareHEVCKeyframeLeadsWithItsParameterSetsAndDecodes() throws {
        let done = DispatchSemaphore(value: 0)
        var produced: EncodedVideo?
        let encoder = VideoEncoder(units: { unit in produced = unit }, completed: { done.signal() })
        try requireHardwareHEVC()
        encoder.use(.hevc)
        XCTAssertEqual(encoder.encode(try picture(), sequence: 1, timestamp: 0, scale: 1, at: 1_000_000), .submitted)
        XCTAssertEqual(done.wait(timeout: .now() + 2), .success)
        let unit = try XCTUnwrap(produced)
        XCTAssertTrue(unit.keyframe)
        XCTAssertEqual(unit.format, .hevc)
        let codec = try XCTUnwrap(unit.codec)
        XCTAssertTrue(codec.hasPrefix("hvc1.1.6.L"), codec)
        let frame = try XCTUnwrap(ingestFrame(unit, now: 2_000_000))
        XCTAssertEqual(frame[31], MediaFrameCodec.hevcAnnexB)
        let payload = try XCTUnwrap(unit.packet(Data()))
        let nals = nalUnits(payload)
        XCTAssertEqual(nals.prefix(3).map { hevcNALType($0[0]) }, [32, 33, 34])
        XCTAssertTrue(nals.dropFirst(3).contains { [19, 20].contains(hevcNALType($0[0])) }, "an IDR slice follows the parameter sets")

        // Decode it as a client would: a format from the parameter sets, the slices length-prefixed.
        var format: CMFormatDescription?
        let sets = nals.prefix(3).map { [UInt8]($0) }
        let status = sets[0].withUnsafeBufferPointer { vps in sets[1].withUnsafeBufferPointer { sps in sets[2].withUnsafeBufferPointer { pps in
            let pointers = [vps.baseAddress!, sps.baseAddress!, pps.baseAddress!]
            return CMVideoFormatDescriptionCreateFromHEVCParameterSets(allocator: nil, parameterSetCount: 3, parameterSetPointers: pointers,
                parameterSetSizes: sets.map(\.count), nalUnitHeaderLength: 4, extensions: nil, formatDescriptionOut: &format)
        } } }
        XCTAssertEqual(status, noErr)
        let description = try XCTUnwrap(format)
        let dimensions = CMVideoFormatDescriptionGetDimensions(description)
        XCTAssertEqual([dimensions.width, dimensions.height], [640, 360])
        var sample = Data()
        for nal in nals.dropFirst(3) {
            var length = UInt32(nal.count).bigEndian
            withUnsafeBytes(of: &length) { sample.append(contentsOf: $0) }
            sample.append(nal)
        }
        var block: CMBlockBuffer?
        XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: sample.count, blockAllocator: nil,
            customBlockSource: nil, offsetToData: 0, dataLength: sample.count, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block), noErr)
        let buffer = try XCTUnwrap(block)
        sample.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: buffer, offsetIntoDestination: 0, dataLength: sample.count) }
        var sampleBuffer: CMSampleBuffer?
        var size = sample.count
        XCTAssertEqual(CMSampleBufferCreateReady(allocator: nil, dataBuffer: buffer, formatDescription: description, sampleCount: 1,
            sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sampleBuffer), noErr)
        var decoder: VTDecompressionSession?
        XCTAssertEqual(VTDecompressionSessionCreate(allocator: nil, formatDescription: description, decoderSpecification: nil,
            imageBufferAttributes: nil, outputCallback: nil, decompressionSessionOut: &decoder), noErr)
        let session = try XCTUnwrap(decoder)
        defer { VTDecompressionSessionInvalidate(session) }
        var decoded: CVImageBuffer?
        var decodeStatus: OSStatus = -1
        XCTAssertEqual(VTDecompressionSessionDecodeFrame(session, sampleBuffer: try XCTUnwrap(sampleBuffer), flags: [], infoFlagsOut: nil) { status, _, image, _, _ in
            decodeStatus = status; decoded = image
        }, noErr)
        VTDecompressionSessionWaitForAsynchronousFrames(session)
        XCTAssertEqual(decodeStatus, noErr)
        XCTAssertEqual(decoded.map { [CVPixelBufferGetWidth($0), CVPixelBufferGetHeight($0)] }, [640, 360])
        encoder.close()
    }

    func testSwitchingBackToH264StartsAnH264KeyframeForTheDaemonSocket() throws {
        let done = DispatchSemaphore(value: 0)
        var produced: EncodedVideo?
        let encoder = VideoEncoder(units: { unit in produced = unit }, completed: { done.signal() })
        try requireHardwareHEVC()
        encoder.use(.hevc)
        XCTAssertEqual(encoder.encode(try picture(), sequence: 1, timestamp: 0, scale: 1, at: 1_000_000), .submitted)
        XCTAssertEqual(done.wait(timeout: .now() + 2), .success)
        encoder.use(.h264)
        XCTAssertEqual(encoder.encode(try picture(), sequence: 2, timestamp: 0, scale: 1, at: 2_000_000), .submitted)
        XCTAssertEqual(done.wait(timeout: .now() + 2), .success)
        let unit = try XCTUnwrap(produced)
        XCTAssertEqual(unit.format, .h264)
        XCTAssertTrue(unit.keyframe)
        XCTAssertTrue(unit.codec?.hasPrefix("avc1.") == true)
        encoder.close()
    }
}
