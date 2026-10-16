from pathlib import Path

p = Path('src/v130-onboarding.js')
s = p.read_text(encoding='utf-8')
old = """  const target = v130OnboardingVersion(env);\n  const profile = await profileSummary(db, phone);\n  const state = await readState(db, phone);\n  // A profile that predates V130 has no onboarding state. Preserve that user as-is\n  // instead of forcing a first-run flow onto an already personalized caller.\n  if (profile && !state && !profile?.onboarding_completed_at) return false;\n  return !(profile?.onboarding_completed_at && Number(profile?.onboarding_version || 0) >= target);\n"""
new = """  const target = v130OnboardingVersion(env);\n  const profile = await profileSummary(db, phone);\n  const state = await readState(db, phone);\n  // A profile that predates V130 has no onboarding state. Preserve that user as-is\n  // instead of forcing a first-run flow onto an already personalized caller.\n  if (profile && !state && !profile?.onboarding_completed_at) return false;\n  // Re-onboarding is complete only when both persisted state and profile agree.\n  // saveV130Terms intentionally raises profile.onboarding_version before completion,\n  // so profile fields alone must never suppress the remaining memory/name steps.\n  const stateComplete = Boolean(state?.completed_at)\n    && String(state?.current_step || '') === 'complete'\n    && Number(state?.onboarding_version || 0) >= target;\n  const profileComplete = Boolean(profile?.onboarding_completed_at)\n    && Number(profile?.onboarding_version || 0) >= target;\n  return !(stateComplete && profileComplete);\n"""
if s.count(old) != 1:
    raise SystemExit(f'expected exactly one generated completion gate, got {s.count(old)}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('V130d version-resume completion gate corrected')
