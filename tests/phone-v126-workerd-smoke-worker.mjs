import { phoneNoiseSuppressionSelfTest } from '../src/telephony/phone-noise-suppressor.js';

export default {
  async fetch() {
    const result = await phoneNoiseSuppressionSelfTest();
    return Response.json(result, { status: result?.ok ? 200 : 500 });
  },
};
