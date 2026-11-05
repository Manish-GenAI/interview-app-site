// Audio capture → local speech-to-text over WebSocket, with a browser speech-recognition fallback (mic only).
import { api, getHealth, getSettings, enc, sleep, DEMO } from './api.js';
import { toast, storageGet, storageSet } from './ui.js';

const WEB_SPEECH_NOTICE_KEY = 'ia.webspeech.notice.v1';

export function speechRecognitionSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}
export function displayCaptureSupported() {
  return Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function wsUrl(params) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, String(v)); });
  return `${proto}//${location.host}/api/stt/ws?${q}`;
}
function safeJSON(data) {
  if (typeof data !== 'string') return null;
  try { return JSON.parse(data); } catch { return null; }
}
function speakerFor(channel) { return channel === 'them' ? 'Them' : 'Me'; }

async function serverSttLikelyAvailable() {
  try {
    const h = await getHealth();
    if (!h.stt) return true;
    return h.stt.available !== false && h.stt.engine !== 'browser' && h.stt.engine !== 'off';
  } catch {
    return true; // let the WebSocket decide
  }
}

async function recognitionLang() {
  try {
    const s = await getSettings();
    const lang = s && s.stt && s.stt.language;
    if (!lang) return navigator.language || 'en-US';
    if (lang.includes('-')) return lang;
    const nav = navigator.language || '';
    return nav.toLowerCase().startsWith(lang.toLowerCase()) ? nav : (lang === 'en' ? 'en-US' : lang);
  } catch {
    return navigator.language || 'en-US';
  }
}

async function acquireStream(source) {
  if (source === 'display') {
    if (!displayCaptureSupported()) {
      throw new Error('This browser cannot capture meeting audio. Use Chrome or Edge on a desktop computer.');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("No audio was shared. Start again and tick \"Share tab audio\" (browser calls) or \"Share system audio\" (desktop apps, Entire screen) in the browser's sharing dialog.");
    }
    return stream;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Microphone access is not available in this browser.');
  }
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
}

function openSocket(params) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(wsUrl(params)); } catch { resolve({ ws: null, msg: { type: 'error' } }); return; }
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => resolve({ ws, msg: { type: 'timeout' } }), 10000);
    ws.onmessage = (ev) => {
      const msg = safeJSON(ev.data);
      if (msg && (msg.type === 'ready' || msg.type === 'unavailable')) { clearTimeout(timer); resolve({ ws, msg }); }
    };
    ws.onerror = () => { clearTimeout(timer); resolve({ ws, msg: { type: 'error' } }); };
    ws.onclose = () => { clearTimeout(timer); resolve({ ws, msg: { type: 'closed' } }); };
  });
}

async function buildGraph(stream) {
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: 16000 }); // Chrome/Edge resample for us
  } catch {
    ctx = new AudioContext();
  }
  let source;
  try {
    source = ctx.createMediaStreamSource(stream);
  } catch {
    // Some browsers refuse a context rate that differs from the device; fall back to the default rate.
    try { await ctx.close(); } catch { /* ignore */ }
    ctx = new AudioContext();
    source = ctx.createMediaStreamSource(stream);
  }
  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
  const node = new AudioWorkletNode(ctx, 'pcm-16k', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = ctx.createGain();
  sink.gain.value = 0; // keep the graph pulled without playing anything back
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* ignore */ } }
  return { ctx, source, node, sink };
}

/**
 * Start capturing audio and streaming it to the local speech engine.
 * opts: { source: 'mic'|'display', mode: 'practice'|'meeting', meetingId, channel: 'me'|'them', offsetSec,
 *         onPartial(text), onFinal({id, speaker, text, t0, t1, channel}), onStatus({type, ...}), onLevel(0..1) }
 * Resolves to a handle: { engine, stop(): Promise, pause(), resume(), paused }.
 */
export async function startCapture(opts) {
  const {
    source = 'mic', mode = 'practice', meetingId, channel = 'me', offsetSec = 0,
    onPartial = () => {}, onFinal = () => {}, onStatus = () => {}, onLevel = null,
  } = opts;

  // If we already know there's no local engine, use the browser recognizer for the mic (or explain for display).
  if (!(await serverSttLikelyAvailable())) {
    if (source === 'mic') return startWebSpeech(opts);
    if (DEMO) throw new Error('Capturing meeting audio needs the installed app (local Whisper). In this demo you can use your microphone or type notes.');
    throw new Error('Meeting audio needs the local speech engine (faster-whisper), which isn\'t available. See System for setup. Your mic can still use the browser\'s speech recognition.');
  }

  // Acquire media first so getDisplayMedia keeps the user's click gesture.
  const stream = await acquireStream(source);
  const { ws, msg } = await openSocket({ mode, channel, meeting_id: meetingId, offset: Number(offsetSec || 0).toFixed(2) });
  if (msg.type !== 'ready') {
    try { ws && ws.close(); } catch { /* ignore */ }
    stream.getTracks().forEach((t) => t.stop());
    if (source === 'mic') return startWebSpeech(opts);
    const why = msg.detail ? ` (${msg.detail})` : '';
    throw new Error(`Meeting audio needs the local speech engine (faster-whisper)${why}.`);
  }

  let graph;
  try {
    graph = await buildGraph(stream);
  } catch (err) {
    try { ws.close(); } catch { /* ignore */ }
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(`Couldn't start audio processing: ${err.message || err}`);
  }

  let stopping = false;
  let paused = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let resolveFlush = null;

  graph.node.port.onmessage = (ev) => {
    const data = ev.data || {};
    if (data.flushed) { if (resolveFlush) resolveFlush(); return; }
    if (data.pcm && ws.readyState === WebSocket.OPEN && !paused) ws.send(data.pcm);
    if (onLevel && typeof data.level === 'number') onLevel(paused ? 0 : data.level);
  };
  ws.onmessage = (ev) => {
    const m = safeJSON(ev.data);
    if (!m) return;
    if (m.type === 'partial') onPartial(m.text || '');
    else if (m.type === 'final') {
      onPartial('');
      if (m.text && m.text.trim()) {
        onFinal({ id: m.segment_id ?? null, speaker: speakerFor(m.channel || channel), text: m.text.trim(), t0: m.t0, t1: m.t1, channel: m.channel || channel });
      }
    } else if (m.type === 'error') onStatus({ type: 'error', message: m.message || m.detail || 'Speech engine error' });
    else if (m.type === 'done') resolveDone();
  };
  ws.onclose = () => {
    resolveDone();
    if (!stopping) onStatus({ type: 'closed', message: 'The speech engine connection closed.' });
  };

  const handle = {
    engine: msg.engine || 'local',
    model: msg.model || '',
    device: msg.device || '',
    get paused() { return paused; },
    pause() {
      if (stopping || paused) return;
      paused = true;
      stream.getAudioTracks().forEach((t) => { t.enabled = false; });
      graph.node.port.postMessage({ cmd: 'pause' });
      onPartial('');
      onStatus({ type: 'paused' });
    },
    resume() {
      if (stopping || !paused) return;
      paused = false;
      stream.getAudioTracks().forEach((t) => { t.enabled = true; });
      graph.node.port.postMessage({ cmd: 'resume' });
      onStatus({ type: 'resumed' });
    },
    async stop() {
      if (stopping) return done;
      stopping = true;
      try {
        const flushed = new Promise((r) => { resolveFlush = r; });
        graph.node.port.postMessage({ cmd: 'flush' });
        await Promise.race([flushed, sleep(600)]);
      } catch { /* ignore */ }
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ }
      await Promise.race([done, sleep(20000)]);
      try { ws.close(); } catch { /* ignore */ }
      stream.getTracks().forEach((t) => t.stop());
      try { graph.source.disconnect(); graph.node.disconnect(); graph.sink.disconnect(); } catch { /* ignore */ }
      try { await graph.ctx.close(); } catch { /* ignore */ }
      onPartial('');
      onStatus({ type: 'stopped' });
      return undefined;
    },
  };

  // The user can end sharing from the browser's own "Stop sharing" bar.
  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => {
    if (!stopping) { onStatus({ type: 'ended', message: 'Audio sharing ended.' }); handle.stop(); }
  }));
  onStatus({ type: 'started', engine: handle.engine, model: handle.model, device: handle.device });
  return handle;
}

function showWebSpeechNotice() {
  if (storageGet(WEB_SPEECH_NOTICE_KEY)) return;
  storageSet(WEB_SPEECH_NOTICE_KEY, true);
  toast("Using your browser's built-in speech recognition. In Chrome and Edge this sends audio to the browser vendor's cloud service. Install the local speech engine (see System) to keep audio on your PC.", 'warn', { timeout: 14000 });
}

/** Fallback: the browser's SpeechRecognition (mic only). */
export async function startWebSpeech(opts) {
  const { mode = 'practice', meetingId, offsetSec = 0, onPartial = () => {}, onFinal = () => {}, onStatus = () => {} } = opts;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    throw new Error("The local speech engine isn't running and this browser has no built-in speech recognition. Type your answer instead, or use Chrome/Edge.");
  }
  showWebSpeechNotice();
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = await recognitionLang();
  const startedAt = performance.now();
  const now = () => Number(offsetSec || 0) + (performance.now() - startedAt) / 1000;
  let stopping = false;
  let paused = false;
  let segStart = null;
  let resolveEnded;
  let ended = new Promise((r) => { resolveEnded = r; });

  rec.onresult = async (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const r = e.results[i];
      const text = (r[0] && r[0].transcript ? r[0].transcript : '').trim();
      if (segStart === null && text) segStart = now();
      if (r.isFinal) {
        if (text) {
          const seg = { id: null, speaker: 'Me', text, t0: segStart ?? now(), t1: now(), channel: 'me' };
          segStart = null;
          if (mode === 'meeting' && meetingId) {
            try {
              const saved = await api(`/api/meetings/${enc(meetingId)}/segments`, { method: 'POST', body: { speaker: 'Me', text, t0: seg.t0, t1: seg.t1 } });
              if (saved && saved.id !== undefined) seg.id = saved.id;
            } catch (err) {
              onStatus({ type: 'error', message: `Couldn't save a transcript line: ${err.detail || err.message}` });
            }
          }
          onFinal(seg);
        }
      } else {
        interim += `${text} `;
      }
    }
    onPartial(interim.trim());
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      stopping = true;
      onStatus({ type: 'error', message: 'Microphone permission was denied.' });
      return;
    }
    onStatus({ type: 'error', message: `Speech recognition error: ${e.error}` });
  };
  rec.onend = () => {
    if (!stopping && !paused) {
      try { rec.start(); } catch { /* already starting */ }
    } else {
      resolveEnded();
    }
  };
  try { rec.start(); } catch (err) { throw new Error(`Couldn't start speech recognition: ${err.message || err}`); }
  onStatus({ type: 'started', engine: 'browser' });

  return {
    engine: 'browser',
    model: '',
    device: '',
    get paused() { return paused; },
    pause() {
      if (stopping || paused) return;
      paused = true;
      try { rec.stop(); } catch { /* ignore */ }
      onPartial('');
      onStatus({ type: 'paused' });
    },
    resume() {
      if (stopping || !paused) return;
      paused = false;
      ended = new Promise((r) => { resolveEnded = r; });
      try { rec.start(); } catch { /* ignore */ }
      onStatus({ type: 'resumed' });
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      try { rec.stop(); } catch { /* ignore */ }
      await Promise.race([ended, sleep(3000)]);
      onPartial('');
      onStatus({ type: 'stopped' });
    },
  };
}

// --- text-to-speech for practice questions --------------------------------------------------------
export function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch { /* ignore */ }
}
export function stopSpeaking() {
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch { /* ignore */ }
}
