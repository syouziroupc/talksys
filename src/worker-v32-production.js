import workerV32, { TalkSysVoiceAgent as TalkSysVoiceAgentV32 } from './worker-v32.js';

function safeSend(connection, payload) {
  try { connection?.send(JSON.stringify(payload)); } catch {}
}

function pcmRms(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 2 || buffer.byteLength % 2) return 0;
  const samples = new Int16Array(buffer);
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export class TalkSysVoiceAgent extends TalkSysVoiceAgentV32 {
  createTranscriber(connection) {
    const transcriber = super.createTranscriber(connection);
    const createSession = transcriber.createSession.bind(transcriber);

    // Instrument the exact server-side STT ingress rather than inferring success from
    // a browser microphone icon. No audio samples are exposed: only counters and RMS.
    transcriber.createSession = (callbacks = {}) => {
      const session = createSession(callbacks);
      const feed = session.feed.bind(session);
      let frames = 0;
      let bytes = 0;

      session.feed = (chunk) => {
        if (chunk instanceof ArrayBuffer && chunk.byteLength >= 2 && chunk.byteLength % 2 === 0) {
          frames += 1;
          bytes += chunk.byteLength;
          if (frames === 1 || frames % 25 === 0) {
            safeSend(connection, {
              type: 'mic_transport',
              phase: frames === 1 ? 'first_frame' : 'receiving',
              frames,
              bytes,
              rms: Number(pcmRms(chunk).toFixed(5)),
              sampleRate: 16000,
              format: 's16le-mono',
            });
          }
        }
        return feed(chunk);
      };
      return session;
    };
    return transcriber;
  }
}

export default {
  async fetch(request, env, ctx) {
    const response = await workerV32.fetch(request, env, ctx);
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/voice-health') return response;

    let data = {};
    try { data = await response.json(); } catch {}
    return Response.json({
      ...data,
      microphoneArchitecture: 'unified-capture-state-machine-v32',
      microphonePlatformBranches: false,
      microphoneStartRequiresRealPcm: true,
      microphoneCaptureRate: 'device-native-resampled-to-16khz',
      microphoneFrameSamples: 640,
      microphoneFrameBytes: 1280,
      microphoneTransportAck: true,
      microphoneServerIngressProbe: 'stt-session-feed-counters-rms',
      microphoneRawAudioInDiagnostics: false,
    }, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-talksys-voice-revision': String(data.voiceRevision || 'cloudflare-agent-v32-coherent-reliable-glm-melo'),
      },
    });
  },
};
