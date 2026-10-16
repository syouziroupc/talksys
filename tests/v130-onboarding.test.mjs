import test from 'node:test';
import assert from 'node:assert/strict';
import { isV130OnboardingPath, v130OnboardingVersion } from '../src/v130-onboarding.js';

test('V130 onboarding version is explicit and bounded', () => {
  assert.equal(v130OnboardingVersion({}), 1);
  assert.equal(v130OnboardingVersion({ PHONE_ONBOARDING_VERSION: '2' }), 2);
  assert.equal(v130OnboardingVersion({ PHONE_ONBOARDING_VERSION: '0' }), 1);
  assert.equal(v130OnboardingVersion({ PHONE_ONBOARDING_VERSION: 'invalid' }), 1);
});

test('V130 onboarding admin routes stay outside realtime endpoints', () => {
  assert.equal(isV130OnboardingPath('/phone/api/v130/onboarding/%2B819012345678'), true);
  assert.equal(isV130OnboardingPath('/phone/api/v130/onboarding/%2B819012345678/allowlist'), true);
  assert.equal(isV130OnboardingPath('/telnyx/media'), false);
  assert.equal(isV130OnboardingPath('/api/transcribe'), false);
  assert.equal(isV130OnboardingPath('/api/turn'), false);
});
