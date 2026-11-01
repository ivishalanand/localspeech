'use strict';
// Headless Electron smoke test: load Kokoro in the MAIN (Node) process,
// synthesize a known phrase, assert non-empty audio, write a WAV, exit 0/1.
// Run: npx electron test/smoke.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';
const OUT = path.join(__dirname, 'smoke-out.wav');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const { KokoroTTS } = require('kokoro-js');
    console.log('[smoke] loading model…');
    const t0 = Date.now();
    const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8' });
    console.log(`[smoke] model ready in ${Date.now() - t0}ms`);

    const t1 = Date.now();
    const audio = await tts.generate('Hello world. This is a local text to speech test.', { voice: VOICE });
    console.log(`[smoke] generated in ${Date.now() - t1}ms`);

    const samples = audio.audio;            // Float32Array
    if (!samples || samples.length === 0) throw new Error('empty audio');
    console.log(`[smoke] samples=${samples.length} rate=${audio.sampling_rate}`);

    fs.writeFileSync(OUT, Buffer.from(audio.toWav()));
    const bytes = fs.statSync(OUT).size;
    if (bytes < 1000) throw new Error(`wav too small: ${bytes} bytes`);
    console.log(`[smoke] wrote ${OUT} (${bytes} bytes)`);

    // Guard the pitch fix: Kokoro `speed` must change tempo (fewer samples), NOT
    // resample. speed:2 should yield ~half the samples of speed:1 — proving the
    // model shortens duration at natural pitch rather than playing back faster.
    const line = 'This is a test of the speech speed control.';
    const slow = (await tts.generate(line, { voice: VOICE, speed: 1 })).audio.length;
    const fast = (await tts.generate(line, { voice: VOICE, speed: 2 })).audio.length;
    const ratio = slow / fast;
    if (ratio < 1.5) throw new Error(`speed not tempo-scaling (ratio ${ratio.toFixed(2)}, want >1.5 — pitch hack regressed?)`);
    console.log(`[smoke] speed tempo-scale ratio=${ratio.toFixed(2)} (slow ${slow} / fast ${fast})`);

    console.log('[smoke] PASS');
    app.exit(0);
  } catch (e) {
    console.error('[smoke] FAIL:', e.message);
    app.exit(1);
  }
});
