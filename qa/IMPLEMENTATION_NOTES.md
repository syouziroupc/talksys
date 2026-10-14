# Direct answer audit implementation notes

- Production target: `POST /api/turn` over HTTP.
- Production model is read from `/gemini-health` and must equal the audit model before the run proceeds.
- Audit calls never use telephone media or speech processing.
- Time-sensitive judging is pinned to the production response `authoritativeJst` value.
- Standard-suite dynamic cases require production search metadata and independent judge search evidence.
- The independent judge uses a fresh interaction and the same production model, with Google Search enabled and JSON-schema constrained output.
- Reports are intentionally evidence-rich: question, production answer, route, production sources, judge verdict, correction, rationale, and independent judge sources are retained.
- Runtime answer behavior is not modified by this QA harness.
