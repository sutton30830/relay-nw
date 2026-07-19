"use client";

import { useRef, useState } from "react";

function writeString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
}

function audioBufferToWav(buffer: AudioBuffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + frames * channels * 2, true);
  writeString(view, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, frames * channels * 2, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}

export function GreetingRecorder({ initialUrl }: { initialUrl: string | null }) {
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(initialUrl);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setMessage(null);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks.current = [];
    recorder.current = new MediaRecorder(stream);
    recorder.current.ondataavailable = (event) => event.data.size && chunks.current.push(event.data);
    recorder.current.onstop = async () => {
      setBusy(true);
      try {
        const source = new Blob(chunks.current, { type: recorder.current?.mimeType || "audio/webm" });
        const context = new AudioContext();
        const decoded = await context.decodeAudioData(await source.arrayBuffer());
        const wav = audioBufferToWav(decoded);
        await context.close();
        const form = new FormData();
        form.set("file", wav, "greeting.wav");
        const response = await fetch("/api/settings/greeting", { method: "POST", body: form });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not save recording");
        setUrl(body.url);
        setMessage("Greeting saved. Play it once before leaving this page.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not save recording");
      } finally {
        stream.getTracks().forEach((track) => track.stop());
        setBusy(false);
      }
    };
    recorder.current.start();
    setRecording(true);
  }

  function stop() {
    recorder.current?.stop();
    setRecording(false);
  }

  return (
    <div className="settings-recorder">
      <input type="hidden" name="missed_call_greeting_audio_url" value={url ?? ""} />
      <div className="lead-controls">
        {!recording ? (
          <button className="btn btn-secondary" type="button" onClick={start} disabled={busy}>Record greeting</button>
        ) : (
          <button className="btn btn-primary" type="button" onClick={stop}>Stop and save</button>
        )}
        {busy ? <span>Preparing audio…</span> : null}
      </div>
      {url ? <audio controls preload="metadata" src={url} /> : null}
      {message ? <p className="form-field__hint" role="status">{message}</p> : null}
    </div>
  );
}
