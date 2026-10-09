const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32635;

export function base64ToBytes(value = '') {
  const binary = atob(String(value || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  for (let i = 0; i < input.length; i += 0x8000) {
    binary += String.fromCharCode(...input.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeMuLawByte(value) {
  const encoded = (~value) & 0xff;
  const sign = encoded & 0x80;
  const exponent = (encoded >> 4) & 0x07;
  const mantissa = encoded & 0x0f;
  let sample = ((mantissa << 3) + MU_LAW_BIAS) << exponent;
  sample -= MU_LAW_BIAS;
  return sign ? -sample : sample;
}

export function encodeMuLawSample(value) {
  let sample = Math.max(-32768, Math.min(32767, Math.round(Number(value) || 0)));
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  sample = Math.min(sample, MU_LAW_CLIP) + MU_LAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; mask >>= 1) exponent -= 1;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function pcmuBase64ToSamples(payload) {
  const bytes = base64ToBytes(payload);
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = decodeMuLawByte(bytes[i]);
  return out;
}

export function rmsOfSamples(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

export function samplesToWav(samples, sampleRate = 8000) {
  const input = samples instanceof Int16Array ? samples : Int16Array.from(samples || []);
  const dataBytes = input.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < input.length; i += 1) view.setInt16(44 + i * 2, input[i], true);
  return buffer;
}
