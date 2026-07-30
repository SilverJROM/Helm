# review.md — B6

## Checklist

- [x] Non-agreement is checked before canonical polling/read/ingest.
- [x] Blocked path returns a typed mechanism-level reason and no plan tasks.
- [x] B5 SHA mismatch remains non-agreement and does not surface an unagreed plan.
- [x] Success path still ingests canonical plan.
- [x] A5/A6 cleanup boundary remains green.
- [x] A0, A5, A6, B1, B2, B3, B4, B5, B6 gate files rerun green.
- [x] No schema or `src/index.ts` edits.

## Residual risk

The B6 worker began code before approval before the outage; the protocol defect is recorded in `callbacks.md`. The final fix cycle was coordinator-validated on settled files after sweeping the stranded worker.
