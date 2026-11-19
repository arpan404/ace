// SPDX-License-Identifier: Apache-2.0
import Foundation
import VideoToolbox
import CoreMedia
import CoreVideo

let directory = CommandLine.arguments[1]
func be(_ n: Int) -> Data { var v = UInt32(n).bigEndian; return Data(bytes:&v,count:4) }
final class ResultData { var description = Data(); var frames = [Data]() }
for (name,codec) in [("h264",kCMVideoCodecType_H264),("hevc",kCMVideoCodecType_HEVC)] {
    let result = ResultData()
    var session: VTCompressionSession?
    let status = VTCompressionSessionCreate(allocator:nil,width:64,height:64,codecType:codec,encoderSpecification:nil,imageBufferAttributes:nil,compressedDataAllocator:nil,outputCallback:{ context, _, status, _, sample in
        guard status == noErr, let sample, let context else { fatalError("encode failed") }
        let result = Unmanaged<ResultData>.fromOpaque(context).takeUnretainedValue()
        if result.description.isEmpty {
            let format = CMSampleBufferGetFormatDescription(sample)!
            let extensions = CMFormatDescriptionGetExtensions(format)! as NSDictionary
            let atoms = extensions[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms] as! NSDictionary
            result.description = atoms[CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_H264 ? "avcC" : "hvcC"] as! Data
        }
        let block = CMSampleBufferGetDataBuffer(sample)!
        var data = Data(count:CMBlockBufferGetDataLength(block))
        data.withUnsafeMutableBytes { bytes in
            _ = CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:bytes.count,destination:bytes.baseAddress!)
        }
        result.frames.append(data)
    },refcon:Unmanaged.passUnretained(result).toOpaque(),compressionSessionOut:&session)
    guard status == noErr, let session else { fatalError("no encoder \(name) \(status)") }
    VTSessionSetProperty(session,key:kVTCompressionPropertyKey_AllowFrameReordering,value:kCFBooleanFalse)
    VTSessionSetProperty(session,key:kVTCompressionPropertyKey_RealTime,value:kCFBooleanTrue)
    for i in 0..<3 {
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil,64,64,kCVPixelFormatType_32BGRA,nil,&buffer)
        let pixel = buffer!
        CVPixelBufferLockBaseAddress(pixel,[])
        memset(CVPixelBufferGetBaseAddress(pixel),128,CVPixelBufferGetDataSize(pixel))
        CVPixelBufferUnlockBaseAddress(pixel,[])
        let properties = [kVTEncodeFrameOptionKey_ForceKeyFrame:true] as CFDictionary
        let s = VTCompressionSessionEncodeFrame(session,imageBuffer:pixel,presentationTimeStamp:CMTime(value:Int64(i),timescale:30),duration:CMTime(value:1,timescale:30),frameProperties:properties,sourceFrameRefcon:nil,infoFlagsOut:nil)
        guard s == noErr else { fatalError("encode \(s)") }
    }
    VTCompressionSessionCompleteFrames(session,untilPresentationTimeStamp:.invalid)
    VTCompressionSessionInvalidate(session)
    var out = be(result.description.count); out.append(result.description)
    for frame in result.frames {out.append(be(frame.count));out.append(frame)}
    try out.write(to:URL(fileURLWithPath:directory+"/"+name+".bin"))
}
