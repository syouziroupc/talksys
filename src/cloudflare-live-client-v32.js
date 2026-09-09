import { CLOUDFLARE_LIVE_CLIENT_V31 } from './cloudflare-live-client-v31.js';

function replaceRequired(source, target, replacement, label) {
  if (!source.includes(target)) throw new Error(`TalkSys v32 client patch target missing: ${label}`);
  return source.replace(target, replacement);
}

let source = CLOUDFLARE_LIVE_CLIENT_V31;

source = replaceRequired(
  source,
  `      if (data.type === 'search_trace') {
        dispatch('talksys-search-trace', data);
        return;
      }
`,
  `      if (data.type === 'turn_trace') {
        dispatch('talksys-turn-trace', data);
        return;
      }
      if (data.type === 'search_trace') {
        dispatch('talksys-search-trace', data);
        return;
      }
`,
  'turn trace websocket dispatch',
);

export const CLOUDFLARE_LIVE_CLIENT_V32 = source;
