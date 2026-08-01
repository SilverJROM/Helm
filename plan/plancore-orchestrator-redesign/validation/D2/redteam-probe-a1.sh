#!/usr/bin/env bash
# D2/R2.6 independent validator red-team probe (does NOT reuse the implementer's vitest harness).
# DENY criterion: peer secret must NEVER appear in output AND the command must exit nonzero.
BIN=/home/agjrom/websites/Helm/dist/tools/helm-sandbox
RUN=$(mktemp -d "$HOME/helm-val-d2-run-XXXXXX"); FENCE=$(mktemp -d "$HOME/helm-val-d2-fence-XXXXXX")
mkdir -p "$RUN/planning-drafts/seat-a" "$RUN/planning-drafts/seat-b"
printf '# plan A\nOWN-DRAFT-A-OK\n'      > "$RUN/planning-drafts/seat-a/draft-seat-a.md"
printf '# plan B\nPEER-DRAFT-B-SECRET\n' > "$RUN/planning-drafts/seat-b/draft-seat-b.md"
echo '{"name":"val-fence"}' > "$FENCE/package.json"
ALLOW="$RUN/planning-drafts/seat-a:/usr:/lib:/lib64:/bin:/etc"   # seat A fence: OWN dir + sys only
probe () {
  out=$(HELM_SANDBOX_RO_PROFILE=strict HELM_SANDBOX_RO_ALLOW="$ALLOW" "$BIN" "$FENCE" bash -c "$2" 2>&1); rc=$?
  leak=$(printf '%s' "$out" | grep -c 'PEER-DRAFT-B-SECRET')
  if [ "$3" = DENY ]; then { [ $rc -ne 0 ] && [ "$leak" -eq 0 ] && v="PASS denied rc=$rc"; } || v="*** FAIL leak=$leak rc=$rc ***"
  else { [ $rc -eq 0 ] && v="PASS allowed"; } || v="*** FAIL rc=$rc ***"; fi
  printf '%-38s %-6s %s\n    %s\n' "$1" "$3" "$v" "$(printf '%s' "$out" | head -1)"
}
echo "== positive controls =="
probe "own draft cat"              "cat $RUN/planning-drafts/seat-a/draft-seat-a.md" ALLOW
probe "own dir ls"                 "ls $RUN/planning-drafts/seat-a" ALLOW
echo "== direct peer access =="
probe "peer draft cat"             "cat $RUN/planning-drafts/seat-b/draft-seat-b.md" DENY
probe "peer dir ls"                "ls $RUN/planning-drafts/seat-b" DENY
probe "drafts-root enumerate"      "ls $RUN/planning-drafts" DENY
probe "runDir ls"                  "ls $RUN" DENY
echo "== escalation attempts =="
probe "relative ../ traversal"     "cd $RUN/planning-drafts/seat-a && cat ../seat-b/draft-seat-b.md" DENY
probe "symlink own->peer"          "ln -s $RUN/planning-drafts/seat-b $RUN/planning-drafts/seat-a/pk 2>/dev/null; cat $RUN/planning-drafts/seat-a/pk/draft-seat-b.md" DENY
probe "hardlink peer into own dir" "ln $RUN/planning-drafts/seat-b/draft-seat-b.md $RUN/planning-drafts/seat-a/st 2>&1; cat $RUN/planning-drafts/seat-a/st" DENY
probe "cp peer into fence dir"     "cp $RUN/planning-drafts/seat-b/draft-seat-b.md $FENCE/x 2>&1; cat $FENCE/x" DENY
probe "grep -r runDir"             "grep -r PEER-DRAFT $RUN" DENY
probe "find peer path"             "find $RUN/planning-drafts -name 'draft-seat-b*'" DENY
probe "realpath+cat peer"          "cat \$(realpath $RUN/planning-drafts/seat-b/draft-seat-b.md 2>/dev/null || echo /nope)" DENY
probe "tar peer dir to stdout"     "tar cf /dev/stdout $RUN/planning-drafts/seat-b" DENY
probe "clobber peer draft (write)" "echo CLOBBER > $RUN/planning-drafts/seat-b/draft-seat-b.md" DENY
echo "== control: engine (unsandboxed) DOES see it =="
echo "    engine read: $(tail -1 "$RUN/planning-drafts/seat-b/draft-seat-b.md")"
rm -rf "$RUN" "$FENCE"
