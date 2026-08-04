# C4 narrow PPS wiring exception

Date: 2026-07-30T10:04:00Z

North ruled C4 may touch `planning-phase-service.ts` narrowly because AC10 cannot land while `runReviewRound` receives only a pre-multiplied timeout scalar. Allowed PPS scope: delete `PLANNING_TIMEOUT_MS * roundCap`, pass `PLANNING_TIMEOUT_MS` and `roundCap` separately into `runReviewRound`, and keep the blocked message accurate. No other PPS edits. Bounded round loop remains in `planning-review-round.ts`. Rule 6 applies at I-P2.
