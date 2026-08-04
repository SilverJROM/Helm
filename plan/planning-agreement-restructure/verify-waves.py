#!/usr/bin/env python3
"""Verify the wave plan's core safety claim: no two slices running CONCURRENTLY
write the same file. Ownership is hand-declared here from WAVE-PLAN.md and checked
against plan.md's slice list for completeness. Fails loudly."""
import re, sys

# concurrent GROUPS per wave. Slices inside one group are serial; groups run in parallel.
# SCOPE 2026-07-30 (JROM): P0+P1+P2+D12 = 24 slices. D1-D11 DEFERRED to a follow-up effort.
# A1..A4 is now ONE serial chain on ONE seat (JROM: serial wins on the E5 path).
WAVES = {
 'W0': [['A0'], ['B1'], ['C1'], ['D12s']],
 'W1': [['A1','A2','A3','A4'], ['A5','A6']],
 'W2': [['B3','B4','B5','B6'], ['B2']],
 'W3a':[['C2']],
 'W3b':[['C3','C4','C5','C6','C7','C8'], ['C9'], ['C10']],
}
DEFERRED = {'D1','D2','D3','D4','D5','D6','D7','D8','D9','D10','D11'}
FILES = {
 'A0':{'test-only'}, 'B1':{'plan-revision.ts'}, 'C1':{'real-transport.ts'}, 'D12s':{'sweep-test'},
 'A1':{'run-orchestrator-service.ts'}, 'A4':{'run-orchestrator-service.ts'},
 'A2':{'worker-runtime-finalize.ts'}, 'A3':{'worker-runtime-finalize.ts'},
 'A5':{'planning-phase-service.ts'}, 'A6':{'planning-phase-service.ts'},
 'B3':{'planning-phase-service.ts'}, 'B4':{'planning-phase-service.ts'},
 'B5':{'planning-phase-service.ts'}, 'B6':{'planning-phase-service.ts'},
 'B2':{'brief-writer-service.ts'}, 'D5':{'planning-provenance-service.ts'},
 'D6':{'discovery-handoff-ingress.ts'},
 'C2':{'planning-phase-service.ts','planning-review-round.ts'},
 'C3':{'planning-review-round.ts'},'C4':{'planning-review-round.ts'},
 'C5':{'planning-review-round.ts'},'C6':{'planning-review-round.ts'},
 'C7':{'planning-review-round.ts'},'C8':{'planning-review-round.ts'},
 'C9':{'brief-writer-service.ts'}, 'C10':{'plan-parser-service.ts'},
 'D2':{'index.ts'}, 'D3':{'app.js'},
 'D7':{'discovery-handoff-owner-bridge.ts'},'D9':{'discovery-handoff-owner-bridge.ts'},
 'D10':{'discovery-handoff-owner-bridge.ts'},
 'D1':{'run-orchestrator-service.ts'},'D8':{'run-orchestrator-service.ts'},
 'D4':{'planning-phase-service.ts'},'D11':{'planning-phase-service.ts'},
}
VERSIONS = {'C10':113}   # only schema slice in scope; D6/D8/D9 reserved v114-116 for the follow-up
fail=[]
for w, groups in WAVES.items():
    for i in range(len(groups)):
        for j in range(i+1, len(groups)):
            fi=set().union(*(FILES[s] for s in groups[i]))
            fj=set().union(*(FILES[s] for s in groups[j]))
            clash=fi & fj
            if clash: fail.append(f"{w}: {groups[i]} ∥ {groups[j]} BOTH WRITE {sorted(clash)}")
# every slice scheduled exactly once
sched=[s for g in WAVES.values() for grp in g for s in grp]
dups=[s for s in set(sched) if sched.count(s)>1]
if dups: fail.append(f"scheduled more than once: {sorted(dups)}")
# completeness vs plan.md
plan_ids=set()
for line in open('plan.md'):
    if not line.startswith('| '): continue
    c=[x.strip() for x in line.strip().strip('|').split('|')]
    if len(c)<11 or c[0].lower()=='id' or set(c[0])<=set('-: '): continue
    plan_ids.add(c[0])
missing = plan_ids - set(sched) - {'D12'} - DEFERRED
if missing: fail.append(f"in plan.md but never scheduled: {sorted(missing)}")
# schema versions unique
if len(set(VERSIONS.values())) != len(VERSIONS): fail.append("duplicate schema versions allocated")
print(f"slices in plan.md: {len(plan_ids)} | in scope: {len(set(sched))+1} (incl D12 at I-P2) | deferred: {len(DEFERRED)}")
print(f"schema versions:   {VERSIONS} — all unique: {len(set(VERSIONS.values()))==len(VERSIONS)}")
print(f"concurrent-group file-collisions: {len(fail)}")
for f in fail: print("  ✗", f)
print("\nRESULT:", "FAIL" if fail else "PASS — no two concurrent slices write the same file")
sys.exit(1 if fail else 0)
