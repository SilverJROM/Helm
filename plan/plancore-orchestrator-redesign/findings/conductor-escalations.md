
## PARKED+RAISED R7 — attempts=1
- why: impl [projcore callback] implementer R7 STATUS: DONE — commit fc7c025 non-convergence BLOCKED + final-positions diff (R3.15)
- gate_failed: None
- action: BRAIN(projcore)/JROM — re-plan/split or supply a DIRECTION. Conductor will NOT re-grind it this run.

## PARKED+RAISED R7 — attempts=0
- why: no-progress loop guard: R7 was already driven 1x this drain and the queue still does not show it DONE. Refusing to re-dispatch — this burns a seat pair per pass with no advance. Cause is almost always an advance that did not persist (marker/queue desync from a `git reset --hard` in a later park rollback). Fix the queue/marker state, then resume.
- gate_failed: None
- action: BRAIN(projcore)/JROM — re-plan/split or supply a DIRECTION. Conductor will NOT re-grind it this run.

## PARKED+RAISED P4 — attempts=1
- why: FAIL but claude-escalation budget exhausted → parked (independence preserved)
- gate_failed: ['verdict=FAIL']
- action: BRAIN(projcore)/JROM — re-plan/split or supply a DIRECTION. Conductor will NOT re-grind it this run.
