import Foundation
import Speech
import AVFoundation
@available(macOS 26.0,*)
func run(_ p:String) async throws {
  let t=SpeechTranscriber(locale: Locale(identifier:"en-US"), preset: .transcription)
  let a=SpeechAnalyzer(modules:[t])
  let f=try AVAudioFile(forReading: URL(fileURLWithPath:p))
  let c=Task { () -> String in var s=""; for try await r in t.results { if r.isFinal { s+=String(r.text.characters) } }; return s }
  let st=Date()
  if let last=try await a.analyzeSequence(from:f) { try await a.finalizeAndFinish(through:last) } else { await a.cancelAndFinishNow() }
  let out=try await c.value
  print("TRANSCRIPT:",out); print("SECONDS:",Date().timeIntervalSince(st))
}
if #available(macOS 26.0,*) {
  let sem=DispatchSemaphore(value:0)
  Task { do { try await run(CommandLine.arguments[1]) } catch { print("ERROR:",error) }; sem.signal() }
  sem.wait()
}
