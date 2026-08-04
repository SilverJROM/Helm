#!/usr/bin/env bash
# 90-minute status to JROM on Telegram (agjasst endpoint). Effort: planning-agreement-restructure.
#
# JROM 2026-07-30: "just do a 1.5hr cadence on the work on this and update me on my TG (agjasst endpt)
# to keep me updated when i check it to know you are progressing reliably. send a test msg now and
# 90mins later"
#
# DELIBERATE POLICY OVERRIDE: the notification protocol's ULTRA-HIGH BAR forbids progress updates.
# JROM owns that rule and has explicitly overridden it for this run. Sanctioned, not drift.
# Alerts still go via guardian/escalate; this is a 📊 channel that cannot be confused with one.
#
# ---- BUGS FROM THE PREVIOUS EFFORT'S REPORTER, FIXED HERE (do not reintroduce) ----
#  1. It parsed queue.md for NUMERIC row ids; this effort's table is plan.md with A0/B1/C10 ids -> 0/0.
#  2. `grep -v` returns exit 1 when it filters EVERYTHING out, and a `|| echo "$ALL"` fallback then
#     reported all slices as remaining at the exact moment the run COMPLETED. Guarded below.
#  3. sort -u put suffixed ids out of PLAN ORDER (D12 before D1) -> wrong "in flight". Plan order kept.
#  4. Worker regex matched another project's sessions (x-11_*_hris). Pinned to ^x-15_.
#  5. Dispatch marker matched case-sensitively ("dispatched" vs "DISPATCHED") -> in-flight timer read 0.
#  6. ALL TIMES IN PHT. JROM lives in PHT; the DB and logs stamp UTC.

RUN_DIR=/home/agjrom/websites/Helm/plan/planning-agreement-restructure
COORD=x-15_projcore_codex55_helm
LOG="$RUN_DIR/tg-status.log"
HAIKU=claude-haiku-4-5-20251001
ENVF=/home/agjrom/TGBOTS/AGJAssist/.env
INTERVAL_MIN=90
PPS=/home/agjrom/websites/Helm/src/services/planning-phase-service.ts

# 24 in scope, in PLAN ORDER. D1-D11 deferred by JROM — never counted as remaining.
SCOPE="A0 A1 A2 A3 A4 A5 A6 B1 B2 B3 B4 B5 B6 C1 C2 C3 C4 C5 C6 C7 C8 C9 C10 D12"

log(){ echo "[$(TZ=Asia/Manila date -Is)] $*" >> "$LOG"; }

send_tg(){
  local text="$1" token chat code
  token=$(grep -oP '^BOT_TOKEN=\K.*' "$ENVF" 2>/dev/null | tr -d '"')
  chat=$(grep -oP '^AUTHORIZED_USER_ID=\K.*' "$ENVF" 2>/dev/null | tr -d '"')
  [ -z "$token" ] || [ -z "$chat" ] && { log "TG creds missing"; return 1; }
  # BUG 8 (12:18 PHT): a transient network outage returned HTTP 000 and the update was silently LOST.
  # JROM checks TG to know the run is progressing, so a dropped report reads as a dead run. Retry.
  local try
  for try in 1 2 3 4 5; do
    code=$(curl -s -m 25 -o /tmp/tg-par-resp.json -w '%{http_code}' \
      "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${chat}" --data-urlencode "text=${text}" \
      --data-urlencode "disable_notification=true")
    [ "$code" = "200" ] && { log "TG -> HTTP 200 (try $try)"; return 0; }
    log "TG -> HTTP $code (try $try/5) — retrying in $((try*30))s"
    sleep $((try * 30))
  done
  log "TG FAILED after 5 tries (last HTTP $code)"; return 1
}

collect(){
  VERIFIED=""; REMAIN=""
  local done_ids
  # BUG 7 (found 09:10 PHT): the coordinator writes "VERIFIED A3" (id AFTER the word), not "A3 VERIFIED".
  # The old id-before-only regex reported 0/24 while 10 slices were genuinely done. Match BOTH orders.
  done_ids=$(grep -ohiE '(\b[ABCD][0-9]+\b[^a-z0-9]{0,4}VERIFIED|VERIFIED[^a-z0-9]{0,4}\b[ABCD][0-9]+\b)' \
               "$RUN_DIR"/progress.md "$RUN_DIR"/callbacks.md 2>/dev/null \
             | grep -oE '[ABCD][0-9]+' | sort -u)
  for s in $SCOPE; do
    if echo "$done_ids" | grep -qx "$s"; then VERIFIED="$VERIFIED $s"; else REMAIN="$REMAIN $s"; fi
  done
  NV=$(echo $VERIFIED | wc -w); NR=$(echo $REMAIN | wc -w)
  INFLIGHT=$(echo $REMAIN | awk '{print $1}')          # plan order, not sort order
  NEXTUP=$(echo $REMAIN | awk '{print $2}')
  # in-flight elapsed, case-insensitive dispatch marker
  local ts
  ts=$(grep -ohiE "\b$INFLIGHT\b[^\n]*dispatch" "$RUN_DIR"/progress.md 2>/dev/null | tail -1 | grep -oE '20[0-9-]+T[0-9:+]+' | tail -1)
  if [ -n "$ts" ]; then INFLIGHT_MIN=$(( ( $(date +%s) - $(date -d "$ts" +%s 2>/dev/null || date +%s) ) / 60 )); else INFLIGHT_MIN=0; fi
  WORKERS=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -cE '^x-15_(impl|val|redteam|settle)')
  BLOCKED=$(cat "$RUN_DIR"/progress.md "$RUN_DIR"/callbacks.md 2>/dev/null | grep -ciE 'STATUS: *(BLOCKED|URGENT)|CONVERGENCE-STALL')
  HB=$(grep -E '^\[hb\]' "$RUN_DIR"/progress.md 2>/dev/null | tail -1 | cut -c1-150)
  PIN=$(grep -c planMdPathForRaceGuard "$PPS" 2>/dev/null)
  JAN=$(tr '\0' '\n' < /proc/$(pm2 pid helm-harness 2>/dev/null | tr -d ' ')/environ 2>/dev/null | grep -oP 'HELM_SESSION_JANITOR=\K.*')
  PHASE="P0 stop-corruption"
  case "$INFLIGHT" in B*) PHASE="P1 fail-closed gate";; C*) PHASE="P2 round machine";; D*) PHASE="D12 regression sweep";; esac
}

report(){
  collect
  local facts="effort=planning-agreement-restructure (attempt 3+ at Helm planning)
scope=24 slices (P0+P1+P2+D12); D1-D11 deferred by JROM
verified=$NV/24
verified_ids=${VERIFIED:- none}
remaining=$NR
in_flight=${INFLIGHT:-none}
in_flight_running_min=$INFLIGHT_MIN
next_up=${NEXTUP:-none}
current_phase=$PHASE
worker_seats_live=$WORKERS
blocked_count=$BLOCKED
raceguard_pin=$PIN (must be 3)
janitor=${JAN:-unknown} (must be 0)
latest_heartbeat=${HB:-none}
time_now_pht=$(TZ=Asia/Manila date '+%Y-%m-%d %H:%M PHT')"
  log "facts: $(echo "$facts" | tr '\n' ' ')"

  local prompt="Write a short Telegram status update for JROM about an autonomous AI build run on his app 'Helm'.

FACTS (invent nothing beyond these):
$facts

Rules:
- First line exactly: 📊 Helm · planning restructure
- Then a blank line, then at most 6 short labelled lines. Phone-readable. No markdown bold, no bullets.
- ALL times in PHT. Never print a UTC timestamp.
- Say plainly what is being worked on now (slice id + the phase in plain words) and verified/24.
- If in_flight_running_min is above 60, add ONE line that the current slice is running long.
- If blocked_count is above 0, say so in one line. Otherwise do not mention blockers.
- If raceguard_pin is not 3, or janitor is not 0, that is a SAFETY ALARM — say it first and plainly.
- This is NOT an alert. No 🚨 or 🛑. Do not ask him to do anything. End with a line saying no action needed.
- Output ONLY the message text."

  local msg
  msg=$(timeout 150 claude -p "$prompt" --model "$HAIKU" 2>/dev/null | sed '/^[[:space:]]*$/{x;/./d;x;}')
  if [ -z "$msg" ]; then
    msg="📊 Helm · planning restructure

Now: ${INFLIGHT:-none} — $PHASE (running ${INFLIGHT_MIN}min)
Done: $NV/24 verified
Remaining: $NR slices
Safety: raceguard=$PIN/3 janitor=${JAN:-?}
Note: haiku unreachable — raw fallback.

No action needed."
    log "haiku unreachable; fallback sent"
  fi
  send_tg "$msg" || log "TG send FAILED"
  log "reported verified=$NV/24 inflight=${INFLIGHT:-none}"
}

case "${1:-loop}" in
  test)
    collect
    send_tg "📊 Helm · planning restructure — cadence test

This is the test message you asked for. 90-minute updates start from here.

Started: $(TZ=Asia/Manila date '+%Y-%m-%d %H:%M PHT')
Scope: 24 slices (P0+P1+P2+D12); D1-D11 deferred
Verified: $NV/24 · now: ${INFLIGHT:-none} ($PHASE)
Safety: raceguard=$PIN/3 · janitor=${JAN:-?}

Next update in 90min. No action needed."
    log "TEST message sent"
    ;;
  once) report ;;
  loop)
    log "cadence START pid=$$ — every ${INTERVAL_MIN}min PHT"
    while :; do sleep $((INTERVAL_MIN * 60)); report; done ;;
esac
