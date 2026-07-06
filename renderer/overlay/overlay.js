// Overlay renderer: recorder pill UI + microphone capture.
// Captures mono PCM via an AudioWorklet, downsamples to 16 kHz, and ships a
// finished WAV buffer to the main process on stop.

const pill = document.getElementById('pill');
const bars = document.getElementById('bars');
const barEls = bars.querySelectorAll('span');
const spin = document.getElementById('spin');
const check = document.getElementById('check');
const label = document.getElementById('label');

let ctx = null;
let stream = null;
let workletNode = null;
let chunks = [];
let capturing = false;
let sampleRate = 16000;

const WORKLET_CODE = `
class PieCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('pie-capture', PieCapture);
`;

async function startCapture(deviceId, processing = true) {
  if (capturing) return;
  chunks = [];
  try {
    const constraints = {
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: processing,
        noiseSuppression: processing,
        autoGainControl: processing,
      },
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    ctx = new AudioContext({ sampleRate: 16000 });
    sampleRate = ctx.sampleRate; // browser may refuse 16k and give 48k; we resample later
    const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(blobUrl);
    const src = ctx.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(ctx, 'pie-capture');
    workletNode.port.onmessage = (e) => {
      if (!capturing) return;
      const f32 = e.data;
      chunks.push(f32);
      updateLevel(f32);
    };
    src.connect(workletNode);
    // do not connect to destination: no monitoring/echo
    capturing = true;
  } catch (err) {
    window.pieOverlay.sendError('Microphone unavailable: ' + (err.message || err.name));
    cleanupAudio();
  }
}

function stopCapture() {
  if (!capturing) {
    window.pieOverlay.sendError('Not recording');
    return;
  }
  capturing = false;
  const wav = buildWav(chunks, sampleRate);
  chunks = [];
  cleanupAudio();
  window.pieOverlay.sendAudio(wav);
}

function cancelCapture() {
  capturing = false;
  chunks = [];
  cleanupAudio();
}

function cleanupAudio() {
  try { workletNode && workletNode.disconnect(); } catch {}
  try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { ctx && ctx.close(); } catch {}
  workletNode = null; stream = null; ctx = null;
}

// Merge chunks, resample to 16 kHz if needed, encode 16-bit PCM WAV.
function buildWav(f32chunks, srcRate) {
  let total = 0;
  for (const c of f32chunks) total += c.length;
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of f32chunks) { merged.set(c, off); off += c.length; }

  const targetRate = 16000;
  let samples = merged;
  if (srcRate !== targetRate) {
    const ratio = srcRate / targetRate;
    const outLen = Math.floor(merged.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, merged.length - 1);
      const frac = pos - i0;
      out[i] = merged[i0] * (1 - frac) + merged[i1] * frac;
    }
    samples = out;
  }

  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);          // PCM
  dv.setUint16(22, 1, true);          // mono
  dv.setUint32(24, targetRate, true);
  dv.setUint32(28, targetRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// ---- level meter ----
let levelSmooth = 0;
function updateLevel(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  const rms = Math.sqrt(sum / f32.length);
  levelSmooth = levelSmooth * 0.7 + rms * 0.3;
  const lvl = Math.min(1, levelSmooth * 9);
  barEls.forEach((b, i) => {
    const mid = (barEls.length - 1) / 2;
    const weight = 1 - Math.abs(i - mid) / (mid + 1);
    const h = 4 + lvl * 18 * (0.45 + weight * 0.75) * (0.75 + Math.random() * 0.4);
    b.style.height = Math.round(h) + 'px';
  });
}

// ---- state display ----
function show(mode) {
  pill.classList.add('visible');
  pill.classList.toggle('cmd', mode === 'command');
}
function setUi({ barsOn = false, spinOn = false, checkOn = false, text = '', err = false }) {
  bars.style.display = barsOn ? 'flex' : 'none';
  spin.style.display = spinOn ? 'block' : 'none';
  check.style.display = checkOn ? 'block' : 'none';
  label.textContent = text;
  label.className = err ? 'err' : '';
  label.style.display = text ? 'block' : 'none';
}

window.pieOverlay.onState((s) => {
  switch (s.state) {
    case 'listening':
      show(s.mode);
      setUi({ barsOn: true, text: s.detail || 'Listening' });
      break;
    case 'processing':
      show(s.mode);
      setUi({ spinOn: true, text: s.detail || 'Processing' });
      break;
    case 'inserting':
      show(s.mode);
      setUi({ spinOn: true, text: 'Typing' });
      break;
    case 'done':
      show(s.mode);
      setUi({ checkOn: true, text: '' });
      break;
    case 'error':
      show(s.mode);
      setUi({ text: s.detail || 'Error', err: true });
      break;
    case 'hidden':
    default:
      pill.classList.remove('visible');
  }
});

window.pieOverlay.onRecStart((opts) => startCapture(opts.deviceId, opts.processing));
window.pieOverlay.onRecStop(() => stopCapture());
window.pieOverlay.onRecCancel(() => cancelCapture());
