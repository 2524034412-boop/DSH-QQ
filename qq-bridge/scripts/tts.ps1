param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$VoiceName = 'Microsoft Huihui Desktop',
  [int]$Rate = 0
)
Add-Type -AssemblyName System.Speech
$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.SelectVoice($VoiceName) } catch {}
$synth.Rate = $Rate
$synth.SetOutputToWaveFile($OutFile)
$synth.Speak($text)
$synth.Dispose()
