// Test-only VideoToolbox decoder for the recording file's actual Annex B access units.
import Foundation
import VideoToolbox

struct DecodeFailure: Error { let message: String }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw DecodeFailure(message: message) }
}
func u32(_ data: Data, _ offset: Int) -> Int {
    (0..<4).reduce(0) { ($0 << 8) | Int(data[offset + $1]) }
}
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
var offset = 0
var format: CMVideoFormatDescription?
var session: VTDecompressionSession?
var decoded = 0
var errors: [OSStatus] = []
while offset < data.count {
    try require(offset + 4 <= data.count, "truncated packet")
    let headerLength = u32(data, offset)
    offset += 4
    try require(offset + headerLength <= data.count, "truncated header")
    let header = try JSONSerialization.jsonObject(with: data.subdata(in: offset..<(offset + headerLength))) as? [String: Any]
    guard let bytes = header?["bytes"] as? Int else { throw DecodeFailure(message: "missing size") }
    offset += headerLength
    try require(bytes > 0 && offset + bytes <= data.count, "truncated access unit")
    let payload = data.subdata(in: offset..<(offset + bytes))
    offset += bytes
    var starts: [Int] = []
    for index in 0..<(payload.count - 3) {
        if payload[index] == 0 && payload[index + 1] == 0 && payload[index + 2] == 0 && payload[index + 3] == 1 { starts.append(index) }
    }
    starts.append(payload.count)
    var sps = Data(), pps = Data(), avcc = Data()
    for index in 0..<(starts.count - 1) {
        let nal = payload.subdata(in: (starts[index] + 4)..<starts[index + 1])
        guard let first = nal.first else { throw DecodeFailure(message: "empty NAL") }
        switch first & 31 {
        case 7: sps = nal
        case 8: pps = nal
        default:
            var size = UInt32(nal.count).bigEndian
            withUnsafeBytes(of: &size) { avcc.append(contentsOf: $0) }
            avcc.append(nal)
        }
    }
    if format == nil {
        try require(!sps.isEmpty && !pps.isEmpty, "recording must begin at a keyframe")
        let status = sps.withUnsafeBytes { spsBytes in
            pps.withUnsafeBytes { ppsBytes in
                let pointers = [spsBytes.bindMemory(to: UInt8.self).baseAddress!, ppsBytes.bindMemory(to: UInt8.self).baseAddress!]
                let sizes = [sps.count, pps.count]
                return pointers.withUnsafeBufferPointer { pointers in
                    sizes.withUnsafeBufferPointer { sizes in
                        CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: nil, parameterSetCount: 2,
                            parameterSetPointers: pointers.baseAddress!, parameterSetSizes: sizes.baseAddress!, nalUnitHeaderLength: 4, formatDescriptionOut: &format)
                    }
                }
            }
        }
        try require(status == noErr, "format: \(status)")
        var callback = VTDecompressionOutputCallbackRecord(decompressionOutputCallback: { _, _, status, _, image, _, _ in
            if status == noErr && image != nil { decoded += 1 } else { errors.append(status) }
        }, decompressionOutputRefCon: nil)
        try require(VTDecompressionSessionCreate(allocator: nil, formatDescription: format!, decoderSpecification: nil,
            imageBufferAttributes: nil, outputCallback: &callback, decompressionSessionOut: &session) == noErr, "decoder create")
    }
    var block: CMBlockBuffer?
    try require(CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: avcc.count, blockAllocator: nil,
        customBlockSource: nil, offsetToData: 0, dataLength: avcc.count, flags: 0, blockBufferOut: &block) == noErr, "block create")
    let copied = avcc.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: avcc.count) }
    try require(copied == noErr, "block copy")
    var sample: CMSampleBuffer?
    var size = avcc.count
    try require(CMSampleBufferCreateReady(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1,
        sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample) == noErr, "sample create")
    try require(VTDecompressionSessionDecodeFrame(session!, sampleBuffer: sample!, flags: [], frameRefcon: nil, infoFlagsOut: nil) == noErr, "decode submit")
}
if let session {
    VTDecompressionSessionFinishDelayedFrames(session)
    VTDecompressionSessionWaitForAsynchronousFrames(session)
    VTDecompressionSessionInvalidate(session)
}
try require(errors.isEmpty, "decode errors: \(errors)")
print(decoded)
