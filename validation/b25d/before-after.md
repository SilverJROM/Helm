# B25d — live master_runtimes orphan delete evidence

**Date:** 2026-07-10  
**Path:** real migrate via `new DatabaseService(data/helm.db)` (schema v77 / `applyB25dDeleteUnknownProviderMasterRuntimes`)  
**Backup:** `data/backups/helm.db.pre-b25d-20260710-124446`  
**Authority:** `decisions/2026-07-10-projcore-orphan-row-disposition.md`

## Before

- schema_version: 76
- master_runtimes count: 2
- rows:

```
1|grok|grok-4.5|running
2|projcore|run-projcore|failed
```

## After

- schema_version: 77
- master_runtimes count: 1
- rows:

```
1|grok|grok-4.5|running
```

## Assertions

- Deleted: `project_id=2 | provider=projcore | model=run-projcore | state=failed`
- Did **not** register provider `projcore`
- Live MODEL_BEARING_COLUMNS sweep: 0 violations (see after JSON)

## After machine JSON

```json
{
  "SCHEMA_VERSION": 77,
  "ver": {
    "version": 77
  },
  "rows": [
    {
      "project_id": 1,
      "provider": "grok",
      "model": "grok-4.5",
      "state": "running"
    }
  ],
  "violationCount": 0,
  "violations": []
}
```
