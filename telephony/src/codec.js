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

export function encodeMuLawSample(sample) {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(Number(sample) || 0)));
  const sign = pcm < 0 ? 0x80 : 0;
  if (pcm < 0) pcm = -pcm;
  if (pcm > MU_LAW_CLIP) pcm = MU_LAW_CLIP;
  pcm += MU_LAW_BIAS;

  let exponent = 0;
  for (let mask = 0x4000; exponent < 7 && (pcm & mask) === 0; mask >>= 1) exponent += 1;
  exponent = 7 - exponent;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function pcmuBase64ToPcm16Base64(payload) {
  const pcmu = base64ToBytes(payload);
  const pcm16 = new Uint8Array(pcmu.length * 2);
  const view = new DataView(pcm16.buffer);
  for (let i = 0; i < pcmu.length; i += 1) {
    view.setInt16(i * 2, decodeMuLawByte(pcmu[i]), true);
  }
  return bytesToBase64(pcm16);
}

export function pcmuBase64ToPcm16kBase64(payload) {
  const pcmu = base64ToBytes(payload);
  if (!pcmu.length) return '';
  const pcm16 = new Uint8Array(pcmu.length * 4);
  const view = new DataView(pcm16.buffer);
  for (let i = 0; i < pcmu.length; i += 1) {
    const current = decodeMuLawByte(pcmu[i]);
    const next = i + 1 < pcmu.length ? decodeMuLawByte(pcmu[i + 1]) : current;
    view.setInt16(i * 4, current, true);
    view.setInt16(i * 4 + 2, Math.round((current + next) / 2), true);
  }
  return bytesToBase64(pcm16);
}

export function pcm16Base64ToPcmu8k(payload, carry = []) {
  const bytes = base64ToBytes(payload);
  const evenLength = bytes.length - (bytes.length % 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, evenLength);
  const samples = Array.isArray(carry) ? [...carry] : Array.from(carry || []);
  for (let offset = 0; offset < evenLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }

  const outputLength = Math.floor(samples.length / 3);
  const pcmu = new Uint8Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const base = i * 3;
    const averaged = (samples[base] + samples[base + 1] + samples[base + 2]) / 3;
    pcmu[i] = encodeMuLawSample(averaged);
  }

  return { pcmu, carry: samples.slice(outputLength * 3) };
}
