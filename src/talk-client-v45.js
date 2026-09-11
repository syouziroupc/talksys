import { TALK_CLIENT_V43 } from './talk-client-v43.js';

export const CLIENT_REVISION = 'talksys-v45-http-adaptive-vad';

let client = TALK_CLIENT_V43
  .replaceAll('talksys-v43-smoke-weather-adaptive-vad', CLIENT_REVISION)
  .replaceAll('TalkSys v43 起動', 'TalkSys v45 起動');

client = client.replace(
  "'use strict';",
  "'use strict';\nwindow.__TALKSYS_CLIENT_REVISION__='" + CLIENT_REVISION + "';",
);

export const TALK_CLIENT_V45 = client;
export const __test = {
  revision: CLIENT_REVISION,
  httpTranscribe: client.includes('/api/transcribe'),
  httpTurns: client.includes('/api/turn'),
  adaptiveNoise: client.includes('noiseBoost'),
  ambientCalibration: client.includes('calibrationUntil'),
  legacyWebSocket: client.includes('new WebSocket') || client.includes('/agents/'),
};
