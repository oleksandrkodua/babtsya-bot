# Бабця з альтанки — project notes for Claude

Telegram bot for a neighbours' group. Cloudflare Worker + D1 + Workers AI.
Requirements: `requirements.md`. Deploy from scratch: `DEPLOY.md`.

## Commands

- Self-checks: `npm test` (= `node src/pipeline.js && node poll.js`). Needs Node 24+.
- Deploy: `./deploy.sh "what changed"` — self-check, commit, `wrangler deploy`.
- Live logs: `npx wrangler tail`.

## Rules

- This repo is public. `wrangler.toml` holds placeholders only; never write real chat ids, `database_id`,
  tokens or secrets into any tracked file. `TELEGRAM_BOT_TOKEN` and `WEBHOOK_SECRET` are Worker secrets
  (`wrangler secret put`).
- User-facing strings and prompts are Ukrainian. Code comments are English, only where the "why" is non-obvious.
- Prompts live in `prompts/*.txt` and are imported as text by the Worker.
- Every text rule in `src/pipeline.js` came from a real failure; keep its case in the self-check when adding one.

## Invariants — do not revert

- The bot answers only its @handle tag — not a reply to it, not a `/command`, not words that name it.
- Replies carry no author name and pass through the `polish` corrector; service labels and foreign scripts are stripped by code.
- Only reposts are filtered from digests; phone numbers and card numbers are redacted before the model sees them.
- A digest message stays under `HARD_LIMIT` (3900) and is always one message.
