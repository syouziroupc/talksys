export default {
  async fetch() {
    try {
      const { phoneNoiseSuppressionSelfTest } = await import('../src/telephony/phone-noise-suppressor.js');
      const result = await phoneNoiseSuppressionSelfTest();
      return Response.json(result);
    } catch (error) {
      return Response.json({
        ok: false,
        stage: 'dynamic-import-or-self-test',
        error: String(error?.message || error || 'unknown workerd error').slice(0, 1000),
        stack: String(error?.stack || '').slice(0, 3000),
      });
    }
  },
};
