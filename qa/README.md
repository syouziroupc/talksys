# TalkSys direct answer quality audit

This audit exercises the production answer engine directly through `POST /api/turn`. It does not use PSTN, Telnyx media, STT, VAD, TTS, PCMU, or the phone personalization path.

## What it checks

The standard suite combines three independent checks:

1. **Deterministic / golden checks** for questions with a stable expected result.
2. **Production grounding checks** for current facts, requiring search execution, sources, and citations where configured.
3. **Independent answer review** in a fresh Gemini interaction using the same production model and Google Search. The reviewer receives the production question, answer, reference timestamp, and source metadata but is instructed to search independently before deciding `pass`, `fail`, or `uncertain`.

The audit intentionally keeps the production answer model unchanged. The reviewer model is required to match `/gemini-health`; a model mismatch aborts the audit instead of silently changing the evaluation model.

## Time-dependent questions

For questions such as "today", "current", and "next train", the reviewer uses the `authoritativeJst` timestamp returned by the production answer as the reference time. This prevents a train departure or other fast-changing fact from being judged against a later clock time simply because the review request ran a few seconds later.

## What this does not prove

No finite test suite can prove that every possible future question will always be correct. A second call to the same model is also not an independent external oracle. The audit reduces this weakness by requiring an independent Google Search, checking citations, mixing fixed-answer cases with dynamic cases, and retaining the full evidence for human inspection.

A failure or `uncertain` verdict is treated as a quality defect to investigate. Passing the suite means the tested answers passed the configured evidence and independent-review checks; it is not a blanket correctness guarantee for untested prompts.

## Running and viewing it

The workflow is `.github/workflows/direct-answer-quality-audit.yml`.

- A push to `main` that changes the audit workflow, runner, or case file runs the suite automatically.
- `workflow_dispatch` allows a manual standard run, filtering by case/category, or entering one arbitrary question.
- The GitHub Actions run summary displays the result table and detailed findings.
- The `answer-quality-report` artifact contains `report.json` and `report.md` for 30 days.

The standard case list is `qa/answer-quality-cases.json`.
