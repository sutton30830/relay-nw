"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

// The core "listen → call back" control, shared by the inbox card and the
// conversation view. It fetches the recording once as a blob (the API route
// needs the auth cookie and doesn't serve range requests), holds the whole file
// in memory so scrubbing is reliable, and revokes the object URL on unmount so
// repeated visits don't leak. Nothing is fetched until the owner hits play, so
// dropping this on every inbox card doesn't download every recording up front.
// fallbackDuration comes from the stored recording_duration and seeds the total
// time before real metadata loads.
export function VoicemailPlayer({
  recordingSid,
  fallbackDuration,
  className,
}: {
  recordingSid: string;
  fallbackDuration?: number | null;
  className?: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "playing" | "paused" | "error">("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration && fallbackDuration > 0 ? fallbackDuration : 0);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function loadAudio() {
    setStatus("loading");
    try {
      const response = await fetch(`/api/recordings/${recordingSid}`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Recording unavailable");
      const blob = await response.blob();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = audioRef.current;
      if (!audio) return;
      audio.src = url;
      setLoaded(true);
      await audio.play();
      setStatus("playing");
    } catch {
      setStatus("error");
    }
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!loaded || !audio) {
      void loadAudio();
      return;
    }

    if (audio.paused) {
      void audio.play();
      setStatus("playing");
    } else {
      audio.pause();
      setStatus("paused");
    }
  }

  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrentTime(value);
  }

  const isBusy = status === "loading";
  const effectiveDuration = duration > 0 ? duration : fallbackDuration ?? 0;

  return (
    <div className={`vm-player ${className ?? ""}`}>
      <audio
        ref={audioRef}
        preload="none"
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onEnded={() => setStatus("paused")}
      />
      <button
        className="vm-player__btn"
        type="button"
        onClick={togglePlayback}
        disabled={isBusy}
        aria-label={status === "playing" ? "Pause voicemail" : "Play voicemail"}
      >
        {isBusy ? <Icon name="clock" size={13} /> : <Icon name={status === "playing" ? "pause" : "play"} size={13} />}
      </button>

      {status === "error" ? (
        <span className="vm-player__error">
          Recording unavailable.{" "}
          <button className="vm-player__retry" type="button" onClick={() => void loadAudio()}>
            Retry
          </button>
        </span>
      ) : (
        <div className="vm-player__scrub">
          <input
            className="vm-player__range"
            type="range"
            min={0}
            max={effectiveDuration || 0}
            step={0.1}
            value={Math.min(currentTime, effectiveDuration || 0)}
            disabled={!loaded || !effectiveDuration}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label="Seek voicemail"
          />
          <span className="vm-player__time" suppressHydrationWarning>
            {formatClock(currentTime)} / {formatClock(effectiveDuration)}
          </span>
        </div>
      )}
    </div>
  );
}
