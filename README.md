# LocalSpeech

Select text in any app, press **⌘⇧S**, and a local neural TTS model reads it aloud.
100% offline — no cloud, no API keys. Apple Silicon.

## Run

```bash
npm install      # also rebuilds onnxruntime-node for Electron + downloads nothing yet
npm start
```

First ⌘⇧S triggers a one-time ~90 MB model download (Kokoro-82M, cached on disk).

### One-time macOS permission

Capturing the selection uses a synthetic ⌘C, which needs **Accessibility** access:
**System Settings → Privacy & Security → Accessibility** → enable the app (or the
terminal you launched it from) → relaunch. The app prompts you on first run.

## Use

1. Select text anywhere (browser, PDF, Notes, …).
2. Press **⌘⇧S**. A floating player appears near the cursor and starts reading,
   highlighting each word as it's spoken.
3. Player controls: **⏸** pause/resume · **⏹** stop · **voice** (8 — US/UK,
   ♀/♂) · speed **0.75×–2×**.
   Press ⌘⇧S on a new selection to interrupt and read it instead.

Voice and speed apply to the next chunk synthesized (they take effect ~1 chunk
later, not mid-word). Speed uses Kokoro's native tempo control, so faster ≠
higher-pitched — the voice stays natural at 2×, no chipmunk effect.

## How it works

- **main.js** — global hotkey, selection capture (AppleScript ⌘C + clipboard restore),
  Kokoro synthesis (`kokoro-js` + native `onnxruntime-node`), sentence-by-sentence
  streaming with one-sentence lookahead, tray, window placement.
- **renderer/** — a thin Web Audio playback sink + the player UI. Receives PCM over IPC.

Synthesis runs in the main (Node) process; the renderer only plays audio.

## Verify

```bash
npm test          # TTS generation (writes a WAV) + end-to-end IPC/playback seam
```

- `npm run test:tts` — loads the model, synthesizes a phrase, asserts non-empty audio, writes `test/smoke-out.wav`.
- `npm run test:e2e` — boots the app with a test utterance and asserts PCM reaches the renderer and playback completes.
