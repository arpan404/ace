import CoreMedia
import CoreVideo
import Foundation

/// Wraps decoded pictures as the display layer takes them, each shown as soon as it is enqueued.
/// The format description is made again only when the pictures' size or format changes.
struct DisplaySamples {
    private var format: CMVideoFormatDescription?

    mutating func sample(_ image: CVPixelBuffer) -> CMSampleBuffer? {
        if format.map({ !CMVideoFormatDescriptionMatchesImageBuffer($0, imageBuffer: image) }) ?? true {
            var described: CMVideoFormatDescription?
            guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image,
                                                               formatDescriptionOut: &described) == noErr else { return nil }
            format = described
        }
        guard let format else { return nil }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
                                        decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: format,
                                                       sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let sample else { return nil }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
            let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dictionary, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        return sample
    }
}
