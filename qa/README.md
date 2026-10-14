# TalkSys answer quality audit

The production quality audit is intentionally attached at the **phone AI boundary**, not at the public Web-chat boundary.

For an audit run, TalkSys substitutes only these two edges:

- **Input:** instead of Telnyx audio → VAD → STT, the audit injects already-transcribed text at the same point where the phone path normally has final STT text.
- **Output:** instead of sending the answer into phone TTS → PCMU → Telnyx, the audit captures the answer text immediately before that output stage.

The live phone service remains active. `/telnyx/voice`, `/telnyx/media`, STT, VAD, interruption handling, TTS and PCMU are not replaced or disabled by the audit route.

## Phone-path conditions retained

The audit sends the answer engine the same phone-boundary contract used by the live telephony path:

- `channel: phone`
- recent conversation history, bounded to the same 16-item window
- phone `sessionId` and `utteranceId`
- `spokenBackchannel`
- optional caller `phoneProfile`

When a caller number is supplied to a manual audit run, the audit reads the same `phone_profiles` fields used by the production phone preload path: display name, personalization text, memory text, enabled flag and profile version.

This makes the harness appropriate for **AI answer quality, search quality and personalization quality** without placing a real phone call. It is not a substitute for separate STT/VAD/TTS/latency testing.

## What it checks

The standard suite combines three checks:

1. **Deterministic / golden checks** for questions with a stable expected result.
2. **Production grounding checks** for current facts, requiring search execution, sources, and citations where configured.
3. **Independent answer review** in a fresh interaction using the same production model and Google Search. The reviewer receives the production question, answer, reference timestamp, and source metadata but is instructed to search independently before deciding `pass`, `fail`, or `uncertain`.

The production answer model is not changed. The reviewer model must match `/gemini-health`; a mismatch aborts the audit instead of silently changing the evaluation model.

## Time-dependent questions

For questions such as "today", "current", and "next train", the reviewer uses the `authoritativeJst` timestamp returned by the production answer as the reference time. This prevents a fast-changing fact from being judged against a later clock time simply because review execution occurred afterward.

## What this does not prove

No finite test suite can prove that every possible future question will always be correct. A second call to the same model is also not an independent external oracle. The audit reduces this weakness by requiring an independent Google Search, checking production evidence, mixing fixed-answer cases with dynamic cases, and retaining evidence for human inspection.

A failure or `uncertain` verdict is treated as a quality defect to investigate. Passing the suite means the tested answers passed the configured checks; it is not a blanket correctness guarantee for untested prompts.

## Running and viewing it

The workflow is `.github/workflows/direct-answer-quality-audit.yml`.

- A push to `main` that changes the audit implementation runs the suite automatically after deployment is available.
- `workflow_dispatch` allows a standard run, filtering by case/category, or entering one arbitrary question.
- An optional `phone_number` input loads that caller's current phone profile for personalization testing.
- The GitHub Actions run summary displays the result table and detailed findings.
- The `answer-quality-report` artifact contains `report.json` and `report.md` for 30 days.

The standard case list is `qa/answer-quality-cases.json`.
