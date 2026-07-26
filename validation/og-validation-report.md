# WK_0621 Validation Report — Helm projcore run 2026-06-21

**Run date**: 2026-06-21
**Final commit**: J1 capstone (see `git log` — commit immediately following 7b5486f)
**Suite**: 314 passed / 3 skipped / 0 failed
**J1 Playwright**: 6/6 PASS
**All requirements**: VERIFIED

## Requirements Evidence

| Req# | Requirement | Batch | Commit | Evidence |
|------|-------------|-------|--------|----------|
| R-01A | Agent Studio default tab = Agents | A1 | 4468432 | batch-A1.md; J1-T1 screenshot |
| R-01B1 | models: validation state column | B1 | 4b7b44a | batch-B1.md |
| R-01B2 | validate via provider headless | B2 | 893648b/57c9c3a | batch-B2.md |
| R-01B3 | Models tab status chip + [test] button | B3 | 7ae9fff | batch-B3.md; J1-T4 screenshot |
| R-01B4 | agent model pickers list valid-only | B4 | a2a2741 | batch-B4.md |
| R-01B5 | backfill: real-test all existing models | B5 | 84772c4 | batch-B5.md |
| R-02A | purge model-named agent rows | D2 | 893847a | batch-D2.md; J1-T2 screenshot |
| R-02B | Agents tab full-width desktop | D3 | 801dfdd | batch-D3.md; J1-T1 screenshot |
| R-02C | agent detail compact + collapsible | D3 | 801dfdd | batch-D3.md; J1-T3 screenshot |
| R-02D | in-detail test-chat (ephemeral real spawn) | D4 | 7fd4623 | batch-D4.md |
| R-02E | per-agent readiness flag + gating | D1,D5 | 64d2978/3652758 | batch-D1.md + batch-D5.md |
| R-02F | master_agent (propose+apply) | E2 | f7b914e | batch-E2.md; J1-T2 screenshot |
| R-02G | model-swap resilience | E2 | f7b914e | batch-E2.md |
| R-02H | holistic Agent Studio layout | D3,F2,G2 | 801dfdd/3c9f84f/0015c70 | batch-D3/F2/G2.md |
| R-03A | teams folded into Agents tab | F2 | 3c9f84f | batch-F2.md |
| R-03B | team_members mixed agent+model | F1 | ff2b40b | batch-F1.md |
| R-03C | teams.protocol_note | F1 | ff2b40b | batch-F1.md |
| R-03D | master_agent can edit teams | F4 | 00998ec | batch-F4.md; J1-T2 screenshot |
| R-03E | team builder UI | F2 | 3c9f84f | batch-F2.md |
| R-03F | vetted-only team membership | F3 | 8d22a4b | batch-F3.md |
| R-04A | gut promote-tmux | A2 | 3752d5f | batch-A2.md; J1-T5 screenshot |
| R-04B | Projects paginated list | H1,H2 | 084a288/ed9dba5 | batch-H1+H2.md; J1-T5 screenshot |
| R-04C | project detail (name/dir + counts) | H1 | 084a288 | batch-H1.md; J1-T6 screenshot |
| R-04D | Solo/Team agent sub-tabs | H3 | 5175803 | batch-H3.md; J1-T6 screenshot |
| R-04E | edit project; delete = row-only + confirm | H2 | ed9dba5 | batch-H2.md |
| R-04F | project-first IA | H1 | 084a288 | batch-H1.md; J1-T5+T6 screenshot |
| R-05A | Documents → Docs + Tasks inner sub-tabs | I2 | faffeee | batch-I2.md; J1-T6 screenshot |
| R-05B | Docs = helm_docs reference docs | I1,I2 | 466b828/faffeee | batch-I1+I2.md |
| R-05C | Tasks = helm_tasks tree | I2 | faffeee | batch-I2.md; J1-T6 screenshot |
| R-05D | per-project folders auto-created | I1 | 466b828 | batch-I1.md; J1-T6 screenshot (scaffolding) |
| R-05E | read-only safe md viewer | I2,G1 | faffeee/5355dd3 | batch-I2+G1.md |
| R-05F | project_maintainer agent | I3 | 7b5486f | batch-I3.md; J1-T2 screenshot |
| R-05G | scaffold helm_docs stubs on create | I1 | 466b828 | batch-I1.md |
| R-06A | shared viewer on agent identity .md | G2 | 0015c70 | batch-G2.md; J1-T3 screenshot |
| R-06B | shared viewer on side-skill .md | G2 | 0015c70 | batch-G2.md |
| R-06C | extract shared md viewer component | G1 | 5355dd3 | batch-G1.md; J1-T3 screenshot |
| R-QA1 | ZERO failing tests app-wide | TZ1 | ab17632 | batch-TZ1.md; 314/3/0 |
| KEY-C1 | interactive agent-chat transport | C1 | 021053d/6defddd | batch-C1.md |
| KEY-E1 | propose→approve substrate | E1 | 65d374e | batch-E1.md |

## J1 Screenshots

| File | Requirement(s) | Description |
|------|----------------|-------------|
| [J1-01-agents-default.png](J1/J1-01-agents-default.png) | R-01A | Agents tab default on login |
| [J1-02-agents-list.png](J1/J1-02-agents-list.png) | R-02A/F, R-05F | Agents list: no model rows; master_agent + project_maintainer |
| [J1-03-agent-detail.png](J1/J1-03-agent-detail.png) | R-02B/C | Agent detail collapsible sections |
| [J1-03b-agent-identity-rendered.png](J1/J1-03b-agent-identity-rendered.png) | R-06A/C | Agent identity MdViewer rendered |
| [J1-04-models-chips.png](J1/J1-04-models-chips.png) | R-01B3 | Models tab validation chips + [test] button |
| [J1-05-projects.png](J1/J1-05-projects.png) | R-04A/B/F | Projects tab, no promote-tmux flow |
| [J1-06-project-detail.png](J1/J1-06-project-detail.png) | R-04C/F | Project detail sub-tabs |
| [J1-07-project-agents-solo-team.png](J1/J1-07-project-agents-solo-team.png) | R-04D | Solo/Team inner tabs |
| [J1-08-project-docs-tasks.png](J1/J1-08-project-docs-tasks.png) | R-05A/C/D | Docs/Tasks inner tabs, helm_docs scaffolded |

## Notes

- The J1 capstone is the first batch to execute the H1–I2 UI at runtime (those batches carried only static gates — app.js is outside `tsconfig` `include` and the studio.spec.ts stubs are `test.skip`). All 6 capstone tests pass against the real app on the Playwright fresh-DB server (`:3111`, `USE_FAKE_TMUX=1`), providing on-screen proof for the project-first IA, Solo/Team agent sub-tabs, Docs/Tasks document split, and helm_docs scaffolding.
- DEV (`pm2 helm`, `:3110`) rebuilt and redeployed; HTTP 200 confirmed post-restart.
