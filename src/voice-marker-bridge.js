export const VOICE_MARKER_BRIDGE = String.raw`(() => {
  'use strict';
  const START = new Uint8Array([0x54,0x53,0x59,0x53,0x01,0x53,0x54,0x41]);
  const END = new Uint8Array([0x54,0x53,0x59,0x53,0x01,0x45,0x4e,0x44]);
  const originalSend = WebSocket.prototype.send;
  if (WebSocket.prototype.__talksysTurnBridge) return;
  Object.defineProperty(WebSocket.prototype, '__talksysTurnBridge', { value: true });
  WebSocket.prototype.send = function(data) {
    originalSend.call(this, data);
    if (typeof data !== 'string') return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message?.type === 'start_of_speech') {
      originalSend.call(this, START.buffer.slice(0));
    } else if (message?.type === 'utterance_commit') {
      originalSend.call(this, END.buffer.slice(0));
    }
  };
})();
`;