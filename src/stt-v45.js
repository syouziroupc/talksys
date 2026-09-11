export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const STT_REVISION = 'talksys-v45-hardened-whisper';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-stt-revision': STT_REVISION,
    },
  });
}

function clean(value, max = 1600) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function base64FromBytes(bytes) {
  let out = '';
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + size)));
  return btoa(out);
}

function ascii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length && offset + i < view.byteLength; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

export function analyzeWav(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 44 || ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') return { valid: false, durationMs: 0, rms: 0, peak: 0, activeMs: 0, activeRatio: 0 };
    let offset = 12, format = 0, channels = 0, sampleRate = 0, bits = 0, dataOffset = -1, dataSize = 0;
    while (offset + 8 <= view.byteLength) {
      const id = ascii(view, offset, 4), size = view.getUint32(offset + 4, true), body = offset + 8;
      if (id === 'fmt ' && size >= 16 && body + 16 <= view.byteLength) {
        format = view.getUint16(body, true); channels = view.getUint16(body + 2, true); sampleRate = view.getUint32(body + 4, true); bits = view.getUint16(body + 14, true);
      } else if (id === 'data') {
        dataOffset = body; dataSize = Math.min(size, Math.max(0, view.byteLength - body)); break;
      }
      offset = body + size + (size & 1);
    }
    if (format !== 1 || channels < 1 || bits !== 16 || sampleRate < 8000 || dataOffset < 0 || dataSize < 2 * channels) return { valid: false, durationMs: 0, rms: 0, peak: 0, activeMs: 0, activeRatio: 0 };
    const sampleCount = Math.floor(dataSize / (2 * channels)), frameSamples = Math.max(1, Math.round(sampleRate * .02));
    let sum = 0, peak = 0, activeFrames = 0, totalFrames = 0, frameSum = 0, frameN = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      let mono = 0;
      for (let c = 0; c < channels; c += 1) mono += view.getInt16(dataOffset + (i * channels + c) * 2, true) / 32768;
      mono /= channels;
      const a = Math.abs(mono); sum += mono * mono; if (a > peak) peak = a; frameSum += mono * mono; frameN += 1;
      if (frameN >= frameSamples || i === sampleCount - 1) {
        const frameRms = Math.sqrt(frameSum / Math.max(1, frameN)); if (frameRms >= 0.006) activeFrames += 1; totalFrames += 1; frameSum = 0; frameN = 0;
      }
    }
    const rms = Math.sqrt(sum / Math.max(1, sampleCount)), durationMs = sampleCount / sampleRate * 1000, activeRatio = totalFrames ? activeFrames / totalFrames : 0, activeMs = activeFrames * 20;
    return { valid: true, durationMs, rms, peak, activeMs, activeRatio, sampleRate, channels };
  } catch {
    return { valid: false, durationMs: 0, rms: 0, peak: 0, activeMs: 0, activeRatio: 0 };
  }
}

export function weakSpeechSignal(metrics) {
  return !metrics?.valid || metrics.durationMs < 260 || metrics.peak < 0.010 || metrics.rms < 0.0018 || metrics.activeMs < 120 || metrics.activeRatio < 0.06;
}

export function isLikelySttHallucination(text, metrics) {
  const value = clean(text, 500);
  if (!value) return true;
  if (/^(?:ご視聴ありがとうございました|ご清聴ありがとうございました|最後までご視聴ありがとうございました|チャンネル登録(?:を)?(?:お願い(?:します|いたします)|よろしくお願いします)|字幕(?:をご覧いただき)?ありがとうございました)[。．.!！?？]*$/u.test(value)
      && (!metrics?.valid || metrics.rms < 0.010 || metrics.activeMs < 650 || metrics.activeRatio < 0.24)) return true;
  if (/^(?:えー|あー|うー|んー|…|\.\.\.)$/u.test(value) && weakSpeechSignal(metrics)) return true;
  return false;
}

export async function transcribeV45(request, env) {
  const started = Date.now();
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength < 800) return json({ ok: false, error: 'audio too short', rejected: 'audio-too-short' }, 400);
  if (buffer.byteLength > 8_000_000) return json({ ok: false, error: 'audio too large' }, 413);

  const metrics = analyzeWav(buffer);
  const signal = {
    durationMs: Math.round(metrics.durationMs || 0),
    rms: Number((metrics.rms || 0).toFixed(5)),
    peak: Number((metrics.peak || 0).toFixed(5)),
    activeMs: Math.round(metrics.activeMs || 0),
    activeRatio: Number((metrics.activeRatio || 0).toFixed(3)),
  };
  if (weakSpeechSignal(metrics)) return json({ ok: false, error: 'no speech detected', rejected: 'weak-speech-signal', elapsedMs: Date.now() - started, signal }, 422);

  try {
    const result = await env.AI.run(STT_MODEL, {
      audio: base64FromBytes(new Uint8Array(buffer)),
      task: 'transcribe',
      language: 'ja',
      vad_filter: true,
      beam_size: 5,
      condition_on_previous_text: false,
      no_speech_threshold: 0.48,
      compression_ratio_threshold: 2.2,
      log_prob_threshold: -0.8,
      hallucination_silence_threshold: 0.5,
    });
    const text = clean(result?.text || result?.transcription_info?.text || result?.transcript || result?.response || '', 1200);
    if (!text) return json({ ok: false, error: 'no speech detected', rejected: 'empty-transcript', elapsedMs: Date.now() - started, signal }, 422);
    if (isLikelySttHallucination(text, metrics)) return json({ ok: false, error: 'hallucinated transcript rejected', rejected: 'hallucination-guard', elapsedMs: Date.now() - started, signal }, 422);
    return json({ ok: true, text, elapsedMs: Date.now() - started, bytes: buffer.byteLength, model: STT_MODEL, revision: STT_REVISION, signal, guard: 'mobile-stt-v45' });
  } catch (error) {
    return json({ ok: false, error: clean(error?.message || error, 240), elapsedMs: Date.now() - started, signal }, 502);
  }
}
