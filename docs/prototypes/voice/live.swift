import Foundation
import Speech
import AVFoundation
@available(macOS 26.0,*)
func run(_ p:String) async throws {
  let t=SpeechTranscriber(locale: Locale(identifier:"en-US"), preset: .progressiveTranscription)
  let a=SpeechAnalyzer(modules:[t])
  let ctx=AnalysisContext(); ctx.contextualStrings[.general]=["Arsenale","arsenalotti","Bucintoro","Venezia"]
  try await a.setContext(ctx)
  guard let fmt=await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:[t]) else { print("nofmt"); return }
  print("BEST_FORMAT:",fmt)
  let f=try AVAudioFile(forReading: URL(fileURLWithPath:p))
  let (stream,cont)=AsyncStream<AnalyzerInput>.makeStream()
  let st=Date()
  var firstAt:Double?=nil
  let c=Task { () -> String in var s=""; for try await r in t.results {
     if firstAt==nil { firstAt=Date().timeIntervalSince(st); print("FIRST_PARTIAL_AT:",firstAt!) }
     if r.isFinal { s+=String(r.text.characters); print("FINAL@",Date().timeIntervalSince(st),String(r.text.characters)) } else { print("partial@",String(format:"%.2f",Date().timeIntervalSince(st)),String(r.text.characters)) } }; return s }
  try await a.start(inputSequence:stream)
  let conv=AVAudioConverter(from:f.processingFormat,to:fmt)!
  let chunk:AVAudioFrameCount=1600
  while true {
    let ib=AVAudioPCMBuffer(pcmFormat:f.processingFormat,frameCapacity:chunk)!
    try f.read(into:ib,frameCount:chunk); if ib.frameLength==0 {break}
    let ob=AVAudioPCMBuffer(pcmFormat:fmt,frameCapacity:AVAudioFrameCount(Double(chunk)*fmt.sampleRate/f.processingFormat.sampleRate)+32)!
    var done=false; var e:NSError?
    conv.convert(to:ob,error:&e){_,st in if done {st.pointee = .noDataNow; return nil}; done=true; st.pointee = .haveData; return ib}
    cont.yield(AnalyzerInput(buffer:ob))
    try await Task.sleep(nanoseconds:100_000_000)
  }
  cont.finish()
  try await a.finalizeAndFinishThroughEndOfInput()
  print("RESULT:",try await c.value); print("TOTAL:",Date().timeIntervalSince(st))
}
if #available(macOS 26.0,*) { let sem=DispatchSemaphore(value:0)
  Task { do { try await run(CommandLine.arguments[1]) } catch { print("ERROR:",error) }; sem.signal() }
  sem.wait() }
