# Helm Telegram Login — Brief for rscf

Read-only research brief. No Helm code was changed to produce this. Scope: how Helm's
"Login via Telegram" flow works end-to-end today, so rscf can decide what to port vs.
redesign.

## 0. The single biggest thing to understand first

**Helm does not run its own Telegram bot.** It has zero bot-token, webhook, or polling
code. It is a pure web app (Fastify + a React-ish frontend served from
`src/web/public/`) that *borrows* an already-running, already-authorized bot belonging
to a sibling project, **AGJAssist** (`/home/agjrom/TGBOTS/AGJAssist`), purely as a
message-delivery and button-tap relay:

```
Helm (web app, no bot)                         AGJAssist (has the real bot)
  POST /api/auth/tg-login-start
        │
        ├─ generates challenge, stores it in Helm's own sqlite ─┐
        │                                                       │
        └── fetch http://127.0.0.1:3101/api/tg/login-challenge ─┴──> validates request is
                                                                       loopback + chatId matches
                                                                       its one authorizedUserId,
                                                                       sends the TG message with
                                                                       3 inline-keyboard buttons
                                                                       (owned by AGJAssist's bot)

  [owner taps a button in Telegram]
                                          AGJAssist's callback_query handler decides
                                          pass/fail, then
                                          POST http://127.0.0.1:<helm-port>/api/auth/tg-callback
        │
  /api/auth/tg-callback (loopback-only) marks the challenge pass/fail in Helm's DB
        │
  GET /api/auth/tg-status (polled by the browser every 2s)
        └─ on first 'pass' read, mints & returns a Helm-signed owner JWT
```

If rscf wants a **self-contained** Telegram login (no dependency on a second running
service), it needs to bring the bot-owning half (§4 below) in-house rather than port
Helm's half verbatim — Helm's own code is only the "web app that asks a bot to relay a
number-match challenge" half.

## 1. Account linking — who becomes "the owner", and how

There is **no runtime account-linking flow** in Helm — no `/start <code>` deep link, no
"scan this to link your Telegram," nothing initiated from Telegram. Helm is
single-tenant/single-owner by design:

- `src/db/schema.ts` — `users` table: `id, telegram_id (UNIQUE), username, display_name,
  role ('owner'|'viewer'), active`. A **partial unique index** enforces at most one row
  with `role='owner' AND active=1` (`idx_users_one_active_owner`).
- `src/auth/owner-bootstrap.ts` — `bootstrapNativeOwner(db, ownerTelegramId)`: idempotent,
  one-time-only setup. If no owner row exists, inserts one with a fixed `id = 1`
  (`NATIVE_OWNER_ID`). If an owner row already exists, it **validates** the existing row
  matches (same id, same telegram_id, active) and **throws** if it doesn't — it never
  repairs or overwrites. This is a fail-closed "the owner identity is fixed at
  provisioning time" guard, not a login-time flow.
- **Gotcha:** grepping the whole repo, `bootstrapNativeOwner` is only referenced from
  two test files (`o2-owner-bootstrap.test.ts`, `o7-native-only-boot.test.ts`) — no
  call site was found in `index.ts` or any script. In the current codebase state, the
  owner's `telegram_id` appears to be seeded into the `users` table directly (manual
  SQL / migration-time step) rather than through any automated boot-time call. Don't
  assume this function actually runs in production without verifying the current
  deploy/seed process.
- Practical implication: "linking" a Telegram account to Helm is an out-of-band,
  deploy-time decision (whoever's `telegram_id` goes in that row *is* the owner), not
  a user-facing flow. If rscf needs multi-user linking (each customer links their own
  Telegram), this part has to be designed from scratch — Helm has nothing to copy here.

## 2. The number-match challenge/approval login

This is the actual "login" UX, and it's asymmetric in an easy-to-misremember way:

- **Web screen shows 1 number.** `src/web/public/app.js` (~line 8164-8169): after
  `tg-login-start`, the login card renders a single large number
  (`tgLogin.displayNumber`) with the text "Open your Telegram and tap this number."
- **Telegram message shows 3 numbers** as inline-keyboard buttons: the real
  `displayNumber` plus 2 decoys, shuffled. Generated in
  `src/auth/tg-login-service.ts` `generateChallenge()`:
  - `displayNumber = randomInt(10, 100)` (2-digit, 10-99)
  - 2 distinct decoys in the same 10-99 range
  - all 3 shuffled via Fisher–Yates before being sent as `buttons`
  - the user must find, in the Telegram chat, the button matching the number shown on
    the web page, and tap *that one*.
- **Challenge lifecycle** (`tg_login_challenges` table: `id, display_number,
  buttons_json, status, created_at, expires_at, consumed_at`):
  - Status machine: `pending → pass|fail`, or `pending → expired` (lazy-evaluated, not
    a cron sweep — `getStatus`/`markResult` check `expires_at` against `now()` on
    every read/write and flip to `expired` on the spot).
  - **TTL: 2 minutes** (`ttlMs = 2 * 60 * 1000` in Helm's service; AGJAssist's own
    in-memory store uses the same `HELM_LOGIN_TTL_MS = 120_000` independently — two
    separate timers that happen to agree, not one shared source of truth).
  - **Single-use / one-shot:** `markResult` only writes if `status === 'pending'`
    (`WHERE id = ? AND status = 'pending'` in the UPDATE) — a second callback for the
    same challenge is a no-op. `consumePassForToken` additionally requires
    `consumed_at IS NULL` and flips it atomically, so the owner JWT can only be minted
    **once** per challenge even if the status-polling `GET` races.
  - **Wrong-tap handling:** on the AGJAssist side, `helmLoginChallengeStore.consume()`
    is called as soon as *any* button is tapped (right vs. wrong), so the challenge is
    burned on the first tap regardless of outcome. Tapping the wrong number edits the
    Telegram message to "❌ Sign-in denied" and posts `result: 'fail'` back to Helm;
    the owner must click "Retry" on the web page (which starts an entirely new
    challenge) — there's no "try again on the same message" path.
  - **Rate limiting:** none found. `tg-login-start` has no per-IP/per-owner throttle
    and no check for an already-pending challenge — a user (or an attacker who can
    reach the endpoint) can trigger many concurrent challenges, each becoming a
    separate Telegram message. Worth hardening if rscf ports this.
- **Session issuance on approval:** `src/api/routes/auth-routes.ts` `GET
  /api/auth/tg-status` is polled by the browser every 2s
  (`src/web/public/app.js` `pollTelegramLogin`, 150s client-side give-up window vs.
  the 2-minute server TTL). On the *first* read where status is `pass`, the route
  calls `tgLoginService.consumePassForToken()` and, only if that succeeds, calls
  `authService.issueOwnerToken()` and returns `{ status: 'pass', token, user }` — every
  subsequent poll just returns `{ status: 'pass' }` with no token. The frontend stores
  the JWT in `sessionStorage` (not `localStorage` — dies when the tab closes) as
  `helm_token` and attaches it as `Authorization: Bearer <token>` on API calls.
  - JWT shape (`src/auth/auth-service.ts` `issueOwnerToken`): `{ sub: user.id, sid:
    'helm-' + 16 random bytes hex, tid: telegramId }`, HS256, `issuer: 'helm'`,
    `audience: 'helm'`, `expiresIn: '24h'`. Verified in `verifyToken` /
    `verifyHelmToken` (checks issuer/audience and that `sid` starts with `'helm-'`).
    Note there's a legacy/dual-path branch in `verifyToken` for AGJAssist-issued
    tokens too (`verifyAgjToken` + a `sessions` table lookup) — that's Helm's own
    historical hybrid-auth migration, almost certainly irrelevant to rscf.

## 3. Opening the app through Telegram

**There isn't one, for Helm.** No Mini App / `WebApp.initData`, no magic link sent
into the chat, nothing. The flow only runs in the *other* direction: the owner is
already on Helm's web login page in a normal browser, clicks "Login via Telegram,"
and the approval happens inside their **existing, ordinary chat** with the AGJAssist
bot (the same chat they already use for other bot commands) — the web page is what's
waiting/polling, not something opened from Telegram.

For completeness, since this is easy to conflate: **AGJAssist itself** (not Helm) does
have both of the patterns you might be picturing, but they're for AGJAssist's *own*
web app, unrelated to Helm:
- `src/auth/telegram-auth.ts` (AGJAssist) — `validateTelegramInitData(initData,
  botToken)`: standard Telegram WebApp `initData` HMAC verification
  (`HMAC-SHA256("WebAppData", botToken)` as the secret key, checks `auth_date` within
  24h). Used by AGJAssist's own auth-service, not by Helm.
- AGJAssist's bot `/weblogin [2|4|8|16]` command generates a short-lived login code
  for AGJAssist's own web app (`assistant-core.ts` ~line 263), and `/app` just replies
  with a static link to `https://agjasst.silverjrom.app` (`assistant-core.ts` line
  272-273) — again, AGJAssist's own app, not Helm.

If rscf wants "open the app from inside Telegram," it has to design that fresh —
nothing in Helm's codebase does it; the closest prior art in this ecosystem is
AGJAssist's `initData`/`/weblogin` pair above, not Helm's.

## 4. Bot wiring (lives in AGJAssist, not Helm)

Since Helm has no bot of its own, "porting the bot wiring" really means looking at
AGJAssist's `src/bot/telegram-bot.ts` + `src/config/config.ts`:

- **Update mode is env-driven, not hardcoded:** `TelegramAssistantOptions.updateMode:
  "webhook" | "polling"`. Config derivation (`config.ts`): if `TELEGRAM_WEBHOOK_URL` is
  set (or falls back to `WEB_APP_URL + webhookPath`), default mode is `"webhook"`;
  otherwise `"polling"`. Can be forced either way via `TELEGRAM_UPDATE_MODE`.
  - Polling path (`startPollingSafely`): calls `bot.deleteWebHook()` first (so you
    can't have both), then `bot.startPolling()`; on failure, schedules a retry every
    30s (`pollingRetryMs`) without crashing the rest of the app.
  - Webhook path (`startWebhook`): `bot.setWebHook(url, { allowed_updates:
    ["message","callback_query"], secret_token })`. Inbound updates land on
    `POST <TELEGRAM_WEBHOOK_PATH>` (default `/api/telegram/webhook`,
    `telegram-webhook-routes.ts`), which does a **timing-safe** comparison of the
    `X-Telegram-Bot-Api-Secret-Token` header against the configured secret before
    calling `telegramAssistant.processUpdate(body)` — this is the only auth on inbound
    webhook traffic, so the secret must be treated as a credential.
- **Per-env bots / token storage:** single bot token per deployment, read from env
  (`BOT_TOKEN`, required — `config.ts` throws via `required("BOT_TOKEN")` if unset),
  passed straight into `new TelegramBot(botToken, { polling: false })` (polling is
  always started manually via `start()`, never via the constructor flag). Authorization
  is a **single allow-listed Telegram user**: `AUTHORIZED_USER_ID` (required, numeric),
  with an optional `AUTHORIZED_CHAT_IDS` list for additional chat IDs. Every inbound
  `message` and `callback_query` handler checks `core.isAuthorized(from.id)` and replies
  "Unauthorized" otherwise (except the Helm passwordless callback path, which does its
  own separate `chatId === config.telegram.authorizedUserId` check at the point Helm's
  challenge is *dispatched*, in `tg-login-routes.ts`). There's no concept of "one bot
  per project" here — it's one bot, one authorized human, shared across whatever chats
  that bot is wired to relay for (Helm's login being one such relay use).
- **The relay endpoint itself:** `src/api/routes/tg-login-routes.ts` `POST
  /api/tg/login-challenge` (AGJAssist side). Guards: caller must be loopback
  (`requireLoopback`), `chatId` must equal the configured `authorizedUserId` exactly
  (rejects anything else — this is what stops a compromised caller from directing
  challenges at an arbitrary chat), `displayNumber`/`buttons` must be well-formed
  2-digit integers with the display number present among exactly 3 buttons, and
  `callbackUrl` must itself be a loopback `http://` URL (stops SSRF-by-callback). On
  success it stores the challenge in AGJAssist's own **in-memory** `Map`
  (`helm-login-store.ts` — not persisted, lost on AGJAssist restart) and sends the
  Telegram message via `bot.sendMessage(chatId, prompt, { reply_markup:
  { inline_keyboard: [...] } })` with `callback_data: "helmpwl:<challengeId>:<n>"` per
  button.
- **Callback handling:** `telegram-bot.ts` `handleHelmPasswordlessCallback` — re-checks
  `isAuthorized`, parses the `helmpwl:` callback_data, consumes the in-memory challenge
  (burns it), decides pass/fail (`helm-login-verdict.ts`, pure `selected ===
  displayNumber`), edits the original Telegram message in place to show
  ✅/❌, answers the callback query (the little Telegram toast), and finally does a
  fire-and-forget `POST` of `{ challengeId, result }` to the `callbackUrl` Helm supplied
  — errors on that POST are only `console.error`'d, never surfaced back to the user in
  Telegram.

## 5. Key files (reference pointers)

**Helm** (`/home/agjrom/websites/Helm/src/`):
- `db/schema.ts` — `users` table (~line 131), `tg_login_challenges` table (~line 771)
- `auth/owner-bootstrap.ts` — one-time owner provisioning/validation
- `auth/tg-login-service.ts` — challenge generation, TTL, one-shot consume, status
- `auth/auth-service.ts` — JWT issuance/verification (`issueOwnerToken`, `verifyToken`)
- `auth/auth-middleware.ts` — Bearer/SSE auth middleware, owner-only guard
- `api/routes/auth-routes.ts` — `tg-login-start`, `tg-callback` (loopback-guarded),
  `tg-status` (the 3 HTTP endpoints Helm exposes for this whole flow)
- `guardrails.ts` — `isLoopbackAddress` / `createRequireLocalLaunch`
- `web/public/app.js` (~lines 1518-1620, ~8146-8178) — frontend polling loop + login UI
- `tg-login.test.ts` — best single source of the exact wire contract (request/response
  shapes, the AGJAssist POST body, loopback-403 behavior, one-shot token semantics)

**AGJAssist** (`/home/agjrom/TGBOTS/AGJAssist/src/`):
- `config/config.ts` (~line 49, 87-126) — `BOT_TOKEN`, `AUTHORIZED_USER_ID`,
  `AUTHORIZED_CHAT_IDS`, webhook/polling mode derivation, webhook secret
- `bot/telegram-bot.ts` — bot lifecycle (`start`, `startPollingSafely`,
  `startWebhook`), all message/callback_query handlers, `sendHelmChallenge`,
  `handleHelmPasswordlessCallback`, `postHelmVerdict`
- `bot/helm-login-store.ts` — in-memory challenge store (put/get/consume/sweep)
- `bot/helm-login-verdict.ts` — the one-line pass/fail decision
- `api/routes/tg-login-routes.ts` — the `/api/tg/login-challenge` relay endpoint Helm
  calls into
- `api/routes/telegram-webhook-routes.ts` — inbound webhook route + secret-token check
- `auth/telegram-auth.ts` — WebApp `initData` HMAC validation (AGJAssist's own app,
  not used by Helm)
- `bot/assistant-core.ts` (~line 263, 272) — `/weblogin`, `/app` commands (AGJAssist's
  own app, not Helm)

## 6. Gotchas / things that will bite a naive port

1. **This is two services talking over loopback HTTP, not one.** Porting "Helm's TG
   login" without also standing up an AGJAssist-equivalent bot process gets you an app
   that calls a URL that doesn't exist. Decide up front whether rscf gets its own bot
   (simpler, self-contained) or relays through something else (mirrors Helm exactly but
   adds an operational dependency).
2. **No real account linking exists to copy.** The owner is a fixed row seeded at
   deploy time, and even that seeding path (`bootstrapNativeOwner`) doesn't appear to
   be wired into the running app. If rscf needs actual per-user Telegram linking
   (receipts app implies multiple customers), this is 100% new design, not a port.
3. **Two independent TTL clocks that happen to agree (120s/2min).** Helm's DB row and
   AGJAssist's in-memory map each expire the challenge separately; they're not
   synchronized by anything other than both being hardcoded to the same number. If you
   port this, pick one TTL source of truth.
4. **AGJAssist's challenge store is in-memory** — a bot restart mid-challenge silently
   loses it (the user just sees "expired" or nothing). Fine for a single-owner internal
   tool; probably not fine if rscf has real end users depending on this to log in.
5. **No rate limiting / no single-flight guard** on challenge creation — spamming
   "Login via Telegram" produces a pile of concurrent Telegram messages to the same
   chat, each independently valid until its own TTL. Worth adding a cooldown or
   invalidate-previous-pending-on-new-challenge rule for a multi-user product.
6. **The webhook secret is the only auth on inbound Telegram traffic** in webhook mode
   — treat `TELEGRAM_WEBHOOK_SECRET` as sensitive as the bot token itself.
7. **The wrong-tap UX is "burn and retry," not "you get 3 tries."** One tap, right or
   wrong, ends that challenge. Simple to implement but worth confirming it's the UX
   rscf actually wants for a customer-facing receipts app (versus, say, a shake-to-deny
   with resend).
8. **Helm's `verifyToken` still carries a legacy dual-path (Helm JWT vs. old AGJAssist
   JWT + `sessions` table lookup)** from an internal migration — almost certainly
   noise for rscf; don't copy that branch, it's Helm-specific hybrid-cutover debt.
9. **Session storage is `sessionStorage`, not `localStorage`** — closing the tab logs
   the owner out even though the JWT itself is valid for 24h server-side. Intentional
   in Helm (single-owner desktop-ish tool); may or may not be what rscf wants for a
   receipts app used from a phone.

STATUS: DONE
