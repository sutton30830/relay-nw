"use client";

import { useEffect, useState } from "react";

export function VoicemailAudio({
  className,
  recordingSid,
}: {
  className?: string;
  recordingSid: string;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;

    async function loadRecording() {
      setAudioUrl(null);
      setError(null);

      try {
            const response = await fetch(`/api/recordings/${recordingSid}`, {
              cache: "no-store",
              credentials: "include",
              signal: controller.signal,
            });

        if (!response.ok) {
          throw new Error("Recording unavailable");
        }

        const audio = await response.blob();
        objectUrl = URL.createObjectURL(audio);
        setAudioUrl(objectUrl);
      } catch (loadError) {
        if (controller.signal.aborted) return;

        setError(loadError instanceof Error ? loadError.message : "Recording unavailable");
      }
    }

    void loadRecording();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [recordingSid]);

  if (error) {
    return <p className="voicemail-audio-status">{error}. Try refreshing or listen from Twilio.</p>;
  }

  if (!audioUrl) {
    return <p className="voicemail-audio-status">Loading voicemail...</p>;
  }

  return (
    <audio className={className} controls src={audioUrl}>
      <a href={`/api/recordings/${recordingSid}`}>Open voicemail</a>
    </audio>
  );
}
