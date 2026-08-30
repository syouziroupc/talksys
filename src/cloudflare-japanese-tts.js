import { cleanSpeechText, MeloJapaneseTTS } from './voice-helpers.js';

export const PRIMARY_TTS_MODEL = '@cf/myshell-ai/melotts';

export class CloudflareJapaneseTTS {
  constructor(ai) {
    this.ai = ai;
    this.melo = new MeloJapaneseTTS(ai);
    this.preferredProvider = 'melotts';
  }

  async synthesize(text, signal) {
    const spoken = cleanSpeechText(text);
    if (!spoken) return null;
    this.preferredProvider = 'melotts';
    return this.melo.synthesize(spoken, signal);
  }
}
