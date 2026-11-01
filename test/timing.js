'use strict';
// Measure synthesis latency: first (cold) generate vs subsequent (warm),
// and short first-chunk vs full sentence. Informs first-audio latency tuning.
const { app } = require('electron');
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';
app.disableHardwareAcceleration();

const now = () => Number(process.hrtime.bigint() / 1000000n);

app.whenReady().then(async () => {
  const { KokoroTTS } = require('kokoro-js');
  let t = now();
  const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8' });
  console.log(`model load: ${now() - t}ms`);

  const gen = async (label, text) => {
    const s = now();
    const r = await tts.generate(text, { voice: VOICE });
    console.log(`${label}: "${text}" -> ${now() - s}ms  (${r.audio.length} samples = ${(r.audio.length/24000).toFixed(2)}s audio)`);
  };

  await gen('COLD first  ', 'Hello.');
  await gen('warm short  ', 'Hello.');
  await gen('warm 3-word ', 'This is interesting.');
  await gen('warm clause ', 'When I press the hotkey,');
  await gen('warm full   ', 'When I press the hotkey, the audio should start almost immediately without a long pause.');

  app.exit(0);
});
