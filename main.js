'use strict';
const {
  app, BrowserWindow, globalShortcut, clipboard, ipcMain,
  systemPreferences, dialog, shell, screen, Tray, Menu, nativeImage,
} = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');

// onnx-community/Kokoro-82M-v1.0 is GATED (→ HTTP 401); the -ONNX repo is public.
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// Voice + speaking rate are set from the player UI (via the 'config' IPC) and
// applied at generation time. rate uses Kokoro's own `speed` (tempo change at
// natural pitch) — NOT playbackRate, which would resample and raise the pitch.
let voice = 'af_heart';
let rate = 1;

let win, tray, tts;
let seq = 0;            // bumped on every new utterance; old speak loops self-abort on mismatch
let activeText = null;  // non-null while speaking (keeps the player from auto-hiding on blur)

app.dock?.hide();
app.on('window-all-closed', () => {}); // menu bar app — stay alive with no windows

// Single-instance lock: a second launch would register ⌘⇧S again and play a
// second overlapping voice. Bail out if another instance already holds the lock.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    createWindow();
    createTray();
    checkAccessibility();
    registerHotkey();
    loadModel();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 560, height: 116,
    frame: false, show: false, alwaysOnTop: true,
    skipTaskbar: true, transparent: true, resizable: false,
    // autoplayPolicy: AudioContext must run without a user gesture (we trigger from a hotkey)
    webPreferences: { nodeIntegration: true, contextIsolation: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (_, _l, m) => console.log('[r]', m));
  win.on('blur', () => { if (!activeText) win.hide(); });

  // Test hook: LOCALSPEECH_TEST="some text" auto-speaks it once the model is ready,
  // so the IPC→Web-Audio playback seam can be verified headlessly (see test/verify.sh).
  if (process.env.LOCALSPEECH_TEST) win.webContents.once('did-finish-load', () => {
    const t = setInterval(() => {
      if (!tts) return;
      clearInterval(t);
      positionWindow(); win.showInactive(); win.webContents.send('reveal');
      speak(process.env.LOCALSPEECH_TEST);
    }, 200);
  });
}

async function loadModel() {
  try {
    const { KokoroTTS } = require('kokoro-js');
    tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8' });
    tray.setToolTip('LocalSpeech — ready (⌘⇧S)');
    console.log('[main] model ready');
  } catch (e) {
    tray.setToolTip('LocalSpeech — model load failed');
    console.error('[main] model load failed:', e.message);
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('LocalSpeech — loading…');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'LocalSpeech', enabled: false },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]));
}

function checkAccessibility() {
  if (systemPreferences.isTrustedAccessibilityClient(false)) return;
  dialog.showMessageBox({
    type: 'info', title: 'Accessibility Required',
    message: 'LocalSpeech needs Accessibility access to capture selected text.',
    detail: 'Open System Settings → Privacy & Security → Accessibility, enable LocalSpeech, then relaunch.',
    buttons: ['Open Settings', 'Later'],
  }).then(({ response }) => {
    if (response === 0)
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });
}

function registerHotkey() {
  const ok = globalShortcut.register('CommandOrControl+Shift+S', async () => {
    if (!tts) return;
    const text = await captureText();
    if (!text) return;
    positionWindow();
    win.showInactive();              // don't steal focus from the app being read
    win.webContents.send('reveal');  // re-trigger the entrance fade
    speak(text);
  });
  if (!ok) console.warn('[main] hotkey registration failed — ⌘⇧S may be in use');
}

// Copy the current selection via a synthetic ⌘C, read it, then restore the clipboard.
async function captureText() {
  const prev = clipboard.readText();
  try {
    execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down']);
  } catch { return null; }
  // Poll for the copy to land instead of a fixed wait — start synthesis as soon
  // as the clipboard changes (typically ~30-50ms), with a 300ms safety cap.
  let text = prev;
  for (let i = 0; i < 30 && text === prev; i++) {
    await new Promise(r => setTimeout(r, 10));
    text = clipboard.readText();
  }
  setImmediate(() => clipboard.writeText(prev));
  return text !== prev ? text.trim() : null;
}

// Split into speakable chunks bounded in length, so the FIRST chunk synthesizes
// fast (first-audio latency ∝ first chunk length). Short sentences stay whole for
// natural prosody; long ones (>12 words) break at clause boundaries (, ; :).
function chunkText(text) {
  const out = [];
  for (const sent of text.split(/(?<=[.!?])\s+/)) {
    const s = sent.trim();
    if (!s) continue;
    if (s.split(/\s+/).length <= 12) out.push(s);
    else out.push(...s.split(/(?<=[,;:])\s+/).map(p => p.trim()).filter(Boolean));
  }
  return out;
}

// Synthesize chunk-by-chunk with one-chunk lookahead so generation of N+1
// overlaps playback of N — closes the inter-chunk gap (gen < playback time).
async function speak(text) {
  const mine = ++seq;
  flushPending();                 // release any await left running by a prior utterance
  activeText = text;

  const chunks = chunkText(text);
  if (!chunks.length) return finish(mine);

  let pending = tts.generate(chunks[0], { voice, speed: rate });
  for (let i = 0; i < chunks.length; i++) {
    let audio;
    try { audio = await pending; }
    catch (e) { console.error('[main] generate:', e.message); break; }
    if (seq !== mine) break;

    if (i + 1 < chunks.length) pending = tts.generate(chunks[i + 1], { voice, speed: rate });

    win.webContents.send('audio', { samples: audio.audio, sampleRate: audio.sampling_rate, text: chunks[i] });
    await new Promise(resolve => ipcMain.once('playback-ended', resolve));
    if (seq !== mine) break;
  }
  finish(mine);
}

function finish(mine) {
  if (seq !== mine) return;
  activeText = null;
  win.hide();
  console.log('[main] speak-complete');
}

function flushPending() { ipcMain.emit('playback-ended'); }

// Bottom-center of the active display's work area — horizontally centered, sitting
// just above the Dock (workArea excludes the Dock and menu bar).
function positionWindow() {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const [w, h] = win.getSize();
  win.setPosition(
    Math.round(workArea.x + (workArea.width - w) / 2),
    Math.round(workArea.y + workArea.height - h - 12),
  );
}

ipcMain.on('control', (_, action) => {
  if (action === 'stop') { seq++; activeText = null; flushPending(); win.hide(); }
});

// Voice / rate changes from the player UI — applied to subsequent generate() calls.
ipcMain.on('config', (_, c) => {
  if (c.voice) voice = c.voice;
  if (c.rate) rate = c.rate;
});

app.on('before-quit', () => globalShortcut.unregisterAll());
