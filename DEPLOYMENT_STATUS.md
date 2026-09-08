# TalkSys deployment status

Production target: `https://talksys.syouziroupc.workers.dev`

Current code target: `cloudflare-agent-v22-grounding-by-default`

The repository validation pipeline passes the full test suite and Wrangler dry-run. Production deployment requires either:

1. Cloudflare Workers Builds connected to `syouziroupc/talksys` production branch `main`, or
2. GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Do not treat a skipped Cloudflare deployment step as a successful production deployment. Always verify `/voice-health` returns the expected `voiceRevision`.
