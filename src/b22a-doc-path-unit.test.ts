/**
 * B22a — R7.26 unit half: helper predicates for the doc-path guard.
 * Allow `src/**`; deny the four governing paths. Wired fence = B22b.
 */
import { describe, it, expect } from 'vitest';
import {
  GOVERNED_DOC_CODE,
  assertProjectWriteAllowed,
  isGovernedDocPath,
  isSrcWritePath,
  normalizeProjectRelPath,
} from './services/doc-path-guard.js';

const CYCLE = 'c01-agent-studio-rebuild';

describe('B22a R7.26 doc-path unit denials', () => {
  describe('normalizeProjectRelPath', () => {
    it('collapses ./ and backslashes to posix rel', () => {
      expect(normalizeProjectRelPath('./src/foo.ts')).toBe('src/foo.ts');
      expect(normalizeProjectRelPath('src\\a\\b.ts')).toBe('src/a/b.ts');
    });

    it('rejects absolute and ..', () => {
      expect(() => normalizeProjectRelPath('/etc/passwd')).toThrow(/traversal|absolute/i);
      expect(() => normalizeProjectRelPath('../north-star.md')).toThrow(/traversal/i);
      try {
        normalizeProjectRelPath('/abs');
        expect.fail('expected throw');
      } catch (e: any) {
        expect(e.code).toBe('TRAVERSAL');
      }
    });
  });

  describe('isSrcWritePath / allow src/**', () => {
    it('allows src root and nested files', () => {
      expect(isSrcWritePath('src')).toBe(true);
      expect(isSrcWritePath('src/foo.ts')).toBe(true);
      expect(isSrcWritePath('src/services/doc-path-guard.ts')).toBe(true);
      expect(isSrcWritePath('./src/a/b.ts')).toBe(true);
    });

    it('assertProjectWriteAllowed does not throw for src/**', () => {
      expect(() => assertProjectWriteAllowed('src/foo.ts')).not.toThrow();
      expect(() => assertProjectWriteAllowed('src/a/b/c.ts')).not.toThrow();
      expect(() => assertProjectWriteAllowed('./src/index.ts')).not.toThrow();
    });

    it('src paths are not classified as governed', () => {
      expect(isGovernedDocPath('src/foo.ts')).toBe(false);
      expect(isGovernedDocPath(`src/plan/${CYCLE}/plan.md`)).toBe(false);
    });
  });

  describe('deny four governed paths', () => {
    const governed = [
      'north-star.md',
      `plan/${CYCLE}/og-requirements.md`,
      `plan/${CYCLE}/plan.md`,
      `plan/${CYCLE}/topology.yaml`,
    ] as const;

    it.each(governed)('isGovernedDocPath(%s) === true', (p) => {
      expect(isGovernedDocPath(p)).toBe(true);
      expect(isSrcWritePath(p)).toBe(false);
    });

    it.each(governed)('assertProjectWriteAllowed(%s) throws GOVERNED_DOC', (p) => {
      try {
        assertProjectWriteAllowed(p);
        expect.fail(`expected denial for ${p}`);
      } catch (e: any) {
        expect(e.code).toBe(GOVERNED_DOC_CODE);
        expect(String(e.message)).toMatch(/governed document write denied/i);
      }
    });

    it('denies ./north-star.md after normalization', () => {
      expect(isGovernedDocPath('./north-star.md')).toBe(true);
      expect(() => assertProjectWriteAllowed('./north-star.md')).toThrow();
      try {
        assertProjectWriteAllowed('./north-star.md');
      } catch (e: any) {
        expect(e.code).toBe(GOVERNED_DOC_CODE);
      }
    });

    it('denies any cycle segment name under plan/', () => {
      expect(isGovernedDocPath('plan/other-cycle/og-requirements.md')).toBe(true);
      expect(isGovernedDocPath('plan/WK_0707/plan.md')).toBe(true);
      expect(isGovernedDocPath('plan/x/topology.yaml')).toBe(true);
      expect(() => assertProjectWriteAllowed('plan/x/topology.yaml')).toThrow(
        expect.objectContaining({ code: GOVERNED_DOC_CODE })
      );
    });
  });

  describe('non-governed non-src classification', () => {
    it('does not mark unrelated plan files as governed', () => {
      expect(isGovernedDocPath(`plan/${CYCLE}/queue.md`)).toBe(false);
      expect(isGovernedDocPath(`plan/${CYCLE}/progress.md`)).toBe(false);
      expect(isGovernedDocPath('plan.md')).toBe(false); // not under plan/<cycle>/
      expect(isGovernedDocPath('og-requirements.md')).toBe(false); // root copy ≠ cycle governed
      expect(() => assertProjectWriteAllowed(`plan/${CYCLE}/queue.md`)).not.toThrow();
    });
  });
});
