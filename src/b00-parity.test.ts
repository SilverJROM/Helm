import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const repoRoot = new URL('../', import.meta.url);
const matrixPath = 'plan/WK_0711/c02-helm-primary-orchestration/validation/parity-matrix.md';

const expectations = [
  ['Validator exception forced to PASS', 'B00.s1a', 'src/b00-red-r1.test.ts', 'B04.s2', 'R13.40, R1.2'],
  ['Inconclusive red-team resolves CLEAN', 'B00.s1b', 'src/b00-red-r1.test.ts', 'B04.s3 (partial) + B10.s3 (full)', 'R13.40, R1.3'],
  ['Empty requirement matrix advances Q0', 'B00.s1c', 'src/b00-red-r1.test.ts', 'B04.s6', 'R13.40, R1.6'],
  ['Deferred pre-live row completes the run', 'B00.s2a', 'src/b00-red-r2r3.test.ts', 'B05.s4', 'R13.40, R2.8'],
  ['Deadline breach survives', 'B00.s2b', 'src/b00-red-r2r3.test.ts', 'B03.s3', 'R13.40, R3.13'],
  ['Dispatch obeys mutable topology drift', 'B00.s3a', 'src/b00-red-r4r10r11.test.ts', 'B06.s1', 'R13.40, R4.17'],
  ['JROM escalation is deferred rather than owner-gated paged', 'B00.s3b', 'src/b00-red-r4r10r11.test.ts', 'B11.s1', 'R13.40, R10.34'],
  ['Terminal completion ignores contradiction outcome', 'B00.s3c', 'src/b00-red-r4r10r11.test.ts', 'B04.s7 + B05.s2 integration', 'R13.40, R11.38'],
  ['Planner fast-path bypasses a co-planner', 'B00.s4a', 'src/b00-red-r7.test.ts', 'B08.s1', 'R13.40, R7.27'],
  ['Brief/runtime `plan.json` split-brain', 'B00.s4b', 'src/b00-red-r7.test.ts', 'B08.s2', 'R13.40, R7.28'],
] as const;

const parseMatrixRow = (row: string) => row.split('|').slice(1, -1).map((cell) => cell.trim());

const headSource = (path: string) => {
  execFileSync('git', ['cat-file', '-e', `HEAD:${path}`], { cwd: repoRoot, encoding: 'utf8' });
  return execFileSync('git', ['show', `HEAD:${path}`], { cwd: repoRoot, encoding: 'utf8' });
};

const hasUnaliasedVitestImport = (sourceFile: ts.SourceFile, binding: 'describe' | 'it') => sourceFile.statements.some((statement) => {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'vitest') return false;
  const bindings = statement.importClause?.namedBindings;
  return Boolean(bindings && ts.isNamedImports(bindings) && bindings.elements.some((element) =>
    !element.propertyName && element.name.text === binding,
  ));
});

const hasLocalItShadow = (callback: ts.ArrowFunction | ts.FunctionExpression) => {
  if (callback.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'it')) return true;
  let shadowed = false;
  const inspect = (node: ts.Node) => {
    if (shadowed) return;
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === 'it') {
      shadowed = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  ts.forEachChild(callback.body, inspect);
  return shadowed;
};

const activeFailDeclarations = (source: string, anchor: string) => {
  const sourceFile = ts.createSourceFile('anchor.ts', source, ts.ScriptTarget.ES2022, true);
  if (!hasUnaliasedVitestImport(sourceFile, 'describe') || !hasUnaliasedVitestImport(sourceFile, 'it')) return 0;
  let declarations = 0;

  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const describe = statement.expression;
    if (!ts.isIdentifier(describe.expression) || describe.expression.text !== 'describe') continue;
    const callback = describe.arguments.at(-1);
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body)) continue;
    if (hasLocalItShadow(callback)) continue;

    let reachable = true;
    for (const child of callback.body.statements) {
      if (!reachable) break;
      if (ts.isExpressionStatement(child) && ts.isCallExpression(child.expression)) {
        const call = child.expression;
        const name = call.arguments[0];
        const testCallback = call.arguments[1];
        if (
          ts.isPropertyAccessExpression(call.expression) &&
          ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'it' && call.expression.name.text === 'fails' &&
          name && ts.isStringLiteral(name) && name.text.startsWith(`${anchor}:`) &&
          testCallback && (ts.isArrowFunction(testCallback) || ts.isFunctionExpression(testCallback))
        ) declarations += 1;
      }
      if (ts.isReturnStatement(child) || ts.isThrowStatement(child)) reachable = false;
    }
  }

  return declarations;
};

describe('B00.s5 R13.40 parity barrier', () => {
  it('maps every enumerated defect class exactly once to a committed failing-by-intent anchor and fix slice', () => {
    const matrix = headSource(matrixPath);
    const rows = matrix.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('|---') && !line.startsWith('| Scenario'));
    const parsedRows = rows.map(parseMatrixRow);
    expect(parsedRows).toHaveLength(expectations.length);

    for (const [scenario, anchor, file, flipSlice, ac] of expectations) {
      const expectedRow = [scenario, anchor, `\`${file}\``, flipSlice, ac];
      expect(parsedRows.filter((row) => row.length === expectedRow.length && row.every((cell, index) => cell === expectedRow[index])), `${anchor} must have exactly one canonical parity row`).toHaveLength(1);

      const source = headSource(file);
      expect(activeFailDeclarations(source, anchor), `${anchor} must have exactly one active it.fails declaration in HEAD`).toBe(1);
    }
  });
});
