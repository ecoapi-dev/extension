export async function speak(text: string) {
  const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/voice-abc/stream", {
    method: "POST",
    body: JSON.stringify({ text, voice_settings: { stability: 0.5 } }),
  });
  return r.arrayBuffer();
}

export async function transcribe(audio: Blob) {
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    body: audio,
  });
  return r.json();
}
