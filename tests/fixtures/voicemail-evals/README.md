# Voicemail audio evaluation

This folder is for local, human-labeled voicemail recordings. Audio and the working
`manifest.json` are intentionally ignored by Git because they can contain personal data.

1. Copy `manifest.example.json` to `manifest.json`.
2. Put consented test recordings in an `audio/` folder here.
3. Transcribe each recording yourself and place the exact human transcript in the manifest.
4. Run `npm run eval:voicemail`.

The command sends every recording through the two confidence-capable GPT-4o transcribers
used by Relay's new pipeline. A case passes only when the primary result has reliable
token confidence, the models agree, and the result stays below the human-labeled word
error rate limit. It never invokes or compares against the legacy Whisper pipeline.

Start with the known “Joe” call and add quiet speech, background noise, short personal
messages, vendor calls, service requests, proper names, phone numbers, and silence.
Use only recordings you are authorized to process.
