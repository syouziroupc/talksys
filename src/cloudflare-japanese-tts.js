import { cleanSpeechText, MeloJapaneseTTS } from './voice-helpers.js';

export const PRIMARY_TTS_MODEL = '@cf/myshell-ai/melotts';

const JAPANESE_READINGS = [
  [/\bPC\b/gi, 'パソコン'],
  [/\bSSD\b/gi, 'エスエスディー'],
  [/\bHDD\b/gi, 'エイチディーディー'],
  [/\bCPU\b/gi, 'シーピーユー'],
  [/\bGPU\b/gi, 'ジーピーユー'],
  [/\bRAM\b/gi, 'メモリー'],
  [/\bUSB\b/gi, 'ユーエスビー'],
  [/\bHDMI\b/gi, 'エイチディーエムアイ'],
  [/\bWi[‐‑‒–—-]?Fi\b/gi, 'ワイファイ'],
  [/\bWeb\b/gi, 'ウェブ'],
  [/\bAI\b/gi, 'エーアイ'],
  [/\bURL\b/gi, 'ユーアールエル'],
  [/\bAPI\b/gi, 'エーピーアイ'],
  [/\bSTT\b/gi, 'エスティーティー'],
  [/\bTTS\b/gi, 'ティーティーエス'],
  [/\bWindows\s*11\b/gi, 'ウィンドウズ イレブン'],
  [/(\d+(?:\.\d+)?)\s*GB\b/gi, '$1ギガバイト'],
  [/(\d+(?:\.\d+)?)\s*MB\b/gi, '$1メガバイト'],
  [/(\d+(?:\.\d+)?)\s*TB\b/gi, '$1テラバイト'],
  [/(\d+(?:\.\d+)?)\s*Gbps\b/gi, '$1ギガビーピーエス'],
  [/(\d+(?:\.\d+)?)\s*Mbps\b/gi, '$1メガビーピーエス'],
  [/(\d+(?:\.\d+)?)\s*GHz\b/gi, '$1ギガヘルツ'],
  [/(\d+(?:\.\d+)?)\s*MHz\b/gi, '$1メガヘルツ'],
  [/(\d+(?:\.\d+)?)\s*Hz\b/gi, '$1ヘルツ'],
  [/(\d+(?:\.\d+)?)\s*%/g, '$1パーセント'],
  [/(\d[\d,]*)\s*円/g, '$1円'],
];

export function normalizeJapaneseTtsText(text) {
  let spoken = cleanSpeechText(text);
  if (!spoken) return '';
  for (const [pattern, replacement] of JAPANESE_READINGS) spoken = spoken.replace(pattern, replacement);
  return spoken
    .replace(/[•●▪■◆◇▶▷→⇒]/g, '、')
    .replace(/[（(]\s*/g, '、')
    .replace(/\s*[）)]/g, '、')
    .replace(/[：:]/g, '、')
    .replace(/[；;]/g, '。')
    .replace(/\s*[\/／]\s*/g, '、')
    .replace(/\s*[|｜]\s*/g, '、')
    .replace(/\s*[—–-]{2,}\s*/g, '、')
    .replace(/([。！？])\s*/g, '$1 ')
    .replace(/、{2,}/g, '、')
    .replace(/。{2,}/g, '。')
    .replace(/\s+/g, ' ')
    .trim();
}

export class CloudflareJapaneseTTS {
  constructor(ai) {
    this.ai = ai;
    this.melo = new MeloJapaneseTTS(ai);
    this.preferredProvider = 'melotts-ja-clarity-normalized';
  }

  async synthesize(text, signal) {
    const spoken = normalizeJapaneseTtsText(text);
    if (!spoken) return null;
    this.preferredProvider = 'melotts-ja-clarity-normalized';
    return this.melo.synthesize(spoken, signal);
  }
}
