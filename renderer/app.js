'use strict';
// Thin playback sink + karaoke-style word highlight. Receives PCM (Float32Array)
// per chunk from main, plays it via Web Audio, and lights up each word in sync
// with the actual audio position. Kokoro gives no word timestamps, so per-word
// timing is estimated proportional to word length; it self-corrects each chunk
// because we know that chunk's exact audio duration.
//
// Speed + voice are NOT applied here — they're sent to main via 'config' and baked
// into synthesis (Kokoro's `speed` = tempo change at natural pitch). So playback is
// always 1.0x: no resampling, no chipmunk pitch.

let audioCtx = null, source = null;
let paused = false;
let wordEls = [], wordEnds = [];   // wordEnds[i] = cumulative end fraction (0..1) of word i
let wordCenterPx = [];             // wordCenterPx[i] = word i's center x in track coords
let vpCenter = 0;                  // focal point = horizontal center of the viewport
let curX = 0;                      // current applied translateX (low-pass smoothed toward target)
let chunkDur = 0, startCtx = 0, rafId = 0, lastIdx = -1;
const $ = id => document.getElementById(id);

// Re-trigger the entrance fade each time the player is (re)shown.
ls.on('reveal', () => {
  const el = $('player');
  el.classList.remove('reveal');
  void el.offsetWidth;            // force reflow so the animation restarts
  el.classList.add('reveal');
});

ls.on('audio', ({ samples, sampleRate, text }) => {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  if (paused) { audioCtx.resume(); paused = false; $('pp').textContent = '⏸'; }

  renderWords(text);
  chunkDur = samples.length / sampleRate;   // already reflects the chosen speed

  const buf = audioCtx.createBuffer(1, samples.length, sampleRate);
  buf.getChannelData(0).set(samples);

  stop();
  source = audioCtx.createBufferSource();
  source.buffer = buf;
  source.connect(audioCtx.destination);
  source.onended = () => ls.send('playback-ended');
  startCtx = audioCtx.currentTime;
  source.start();
  runHighlight();
});

// Render the chunk into the teleprompter track and measure each word's center,
// plus its length-weighted end-fraction (a duration proxy) for scroll timing.
function renderWords(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const weights = tokens.map(t => t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let cum = 0;
  wordEnds = weights.map(w => (cum += w) / total);

  const track = $('track');
  track.textContent = '';
  lastIdx = -1;
  wordEls = tokens.map((t, i) => {
    const el = document.createElement('span');
    el.className = 'word';
    el.textContent = t;
    track.appendChild(el);
    if (i < tokens.length - 1) track.appendChild(document.createTextNode(' '));
    return el;
  });

  // Measure once (forces one reflow): each word's center x within the track.
  vpCenter = $('text').clientWidth / 2;
  wordCenterPx = wordEls.map(w => w.offsetLeft + w.offsetWidth / 2);

  // Start already centered on the first word (sub-pixel, no rounding → no jitter).
  curX = vpCenter - (wordCenterPx[0] || 0);
  track.style.transform = `translateX(${curX}px)`;
  console.log('hl render n=' + wordEls.length);
}

// Drive scrolling from the real audio clock (AudioContext.currentTime freezes while
// suspended, so pause/resume and the inter-chunk gap are handled for free). Every
// frame we move the track so the smooth read-position sits at the focal point —
// continuous glide, no per-word hops or stops.
function runHighlight() {
  cancelAnimationFrame(rafId);
  let doneLogged = false;
  const tick = () => {
    if (!source) return;
    const frac = Math.min(1, (audioCtx.currentTime - startCtx) / chunkDur);
    if (wordCenterPx.length) {
      const targetX = vpCenter - readPxAt(frac);
      curX += (targetX - curX) * 0.2;       // low-pass: damps velocity steps at word boundaries
      $('track').style.transform = `translateX(${curX}px)`;
      let idx = wordEnds.findIndex(e => frac < e);
      if (idx === -1) idx = wordEls.length - 1;
      setActive(idx);
    }
    if (frac < 1) rafId = requestAnimationFrame(tick);
    else if (!doneLogged) { doneLogged = true; console.log('hl done'); }
  };
  rafId = requestAnimationFrame(tick);
}

// Smooth read-position (px in track coords) at playback fraction `frac`: interpolate
// between the current word's center and the next word's center, so position advances
// continuously rather than snapping word-to-word.
function readPxAt(frac) {
  let i = wordEnds.findIndex(e => frac < e);
  if (i === -1) i = wordCenterPx.length - 1;
  const start = i === 0 ? 0 : wordEnds[i - 1];
  const span = (wordEnds[i] - start) || 1;
  const p = Math.max(0, Math.min(1, (frac - start) / span));
  const c0 = wordCenterPx[i];
  const c1 = wordCenterPx[i + 1] !== undefined ? wordCenterPx[i + 1] : c0;
  return c0 + p * (c1 - c0);
}

// Pill only — the active word's amber background. Motion is handled by the scroll.
function setActive(idx) {
  if (idx === lastIdx) return;
  if (wordEls[lastIdx]) wordEls[lastIdx].classList.remove('active');
  lastIdx = idx;
  if (wordEls[idx]) wordEls[idx].classList.add('active');
}

function stop() {
  cancelAnimationFrame(rafId);
  if (!source) return;
  source.onended = null;     // suppress the natural-end signal on a forced stop
  try { source.stop(); } catch {}
  source = null;
}

$('pp').onclick = () => {
  if (!audioCtx) return;
  paused = !paused;
  if (paused) { audioCtx.suspend(); cancelAnimationFrame(rafId); $('pp').textContent = '▶'; }
  else        { audioCtx.resume();  runHighlight();             $('pp').textContent = '⏸'; }
};

$('stop').onclick = () => {
  stop(); paused = false;
  $('pp').textContent = '⏸';
  const track = $('track');
  track.textContent = '—';
  track.style.transform = 'translateX(0)';
  wordEls = []; wordCenterPx = []; lastIdx = -1;
  ls.send('control', 'stop');
};

// Speed + voice take effect on the next chunk synthesized by main.
$('speed').onchange = e => ls.send('config', { rate: parseFloat(e.target.value) });
$('voice').onchange = e => ls.send('config', { voice: e.target.value });
