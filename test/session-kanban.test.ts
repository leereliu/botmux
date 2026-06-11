import { describe, expect, it } from 'vitest';
import {
  KANBAN_COLUMN_IDS,
  normalizeKanbanColumn,
  normalizeKanbanPosition,
  normalizeSessionTitle,
} from '../src/core/session-board.js';
import {
  computeDropPosition,
  deriveKanbanColumn,
  effectiveKanbanPosition,
} from '../src/dashboard/web/kanban-model.js';

describe('session-board normalizers', () => {
  it('accepts only known kanban columns', () => {
    for (const id of KANBAN_COLUMN_IDS) expect(normalizeKanbanColumn(id)).toBe(id);
    expect(normalizeKanbanColumn('doing')).toBeNull();
    expect(normalizeKanbanColumn('')).toBeNull();
    expect(normalizeKanbanColumn(undefined)).toBeNull();
    expect(normalizeKanbanColumn(3)).toBeNull();
  });

  it('accepts only finite numbers as positions', () => {
    expect(normalizeKanbanPosition(0)).toBe(0);
    expect(normalizeKanbanPosition(1536.5)).toBe(1536.5);
    expect(normalizeKanbanPosition(-1024)).toBe(-1024);
    expect(normalizeKanbanPosition(Number.NaN)).toBeNull();
    expect(normalizeKanbanPosition(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeKanbanPosition('5')).toBeNull();
    expect(normalizeKanbanPosition(undefined)).toBeNull();
  });

  it('trims, flattens newlines, and caps the title; rejects empty/non-string', () => {
    expect(normalizeSessionTitle('  修复登录 bug  ')).toBe('修复登录 bug');
    expect(normalizeSessionTitle('第一行\n  第二行')).toBe('第一行 第二行');
    expect(normalizeSessionTitle('a'.repeat(300))).toHaveLength(200);
    expect(normalizeSessionTitle('   ')).toBeNull();
    expect(normalizeSessionTitle('')).toBeNull();
    expect(normalizeSessionTitle(42)).toBeNull();
    expect(normalizeSessionTitle(undefined)).toBeNull();
  });
});

describe('deriveKanbanColumn', () => {
  it('forces closed sessions into done, ignoring manual placement', () => {
    expect(deriveKanbanColumn({ status: 'closed' })).toBe('done');
    expect(deriveKanbanColumn({ status: 'closed', kanbanColumn: 'in_progress' })).toBe('done');
  });

  it('manual placement wins over runtime derivation', () => {
    expect(deriveKanbanColumn({ status: 'working', kanbanColumn: 'backlog' })).toBe('backlog');
    expect(deriveKanbanColumn({ status: 'idle', kanbanColumn: 'done' })).toBe('done');
  });

  it('falls back to runtime derivation when manual value is invalid', () => {
    expect(deriveKanbanColumn({ status: 'working', kanbanColumn: 'nope' })).toBe('in_progress');
  });

  it('routes needs-you signals to in_review', () => {
    expect(deriveKanbanColumn({ status: 'working', pendingRepo: true })).toBe('in_review');
    expect(deriveKanbanColumn({ status: 'idle', tuiPromptActive: true })).toBe('in_review');
    expect(deriveKanbanColumn({ status: 'idle', agentAttention: { kind: 'x', reason: 'y', at: 1 } })).toBe('in_review');
    expect(deriveKanbanColumn({ status: 'limited' })).toBe('in_review');
  });

  it('maps runtime states to default columns', () => {
    for (const status of ['starting', 'working', 'analyzing', 'active']) {
      expect(deriveKanbanColumn({ status })).toBe('in_progress');
    }
    expect(deriveKanbanColumn({ status: 'idle' })).toBe('todo');
  });
});

describe('effectiveKanbanPosition', () => {
  it('pinned positions sort before unpinned cards', () => {
    const pinned = effectiveKanbanPosition({ kanbanPosition: 99999, lastMessageAt: Date.now() });
    const unpinned = effectiveKanbanPosition({ lastMessageAt: Date.now() });
    expect(pinned).toBeLessThan(unpinned);
  });

  it('orders unpinned cards by recency (newer first = smaller key)', () => {
    const newer = effectiveKanbanPosition({ lastMessageAt: 2_000 });
    const older = effectiveKanbanPosition({ lastMessageAt: 1_000 });
    expect(newer).toBeLessThan(older);
  });

  it('ignores non-finite stored positions', () => {
    expect(effectiveKanbanPosition({ kanbanPosition: Number.NaN, lastMessageAt: 0 }))
      .toBe(effectiveKanbanPosition({ lastMessageAt: 0 }));
  });
});

describe('computeDropPosition', () => {
  it('uses the midpoint between two neighbours', () => {
    expect(computeDropPosition(1024, 2048)).toBe(1536);
  });

  it('steps outward at column edges', () => {
    expect(computeDropPosition(1024, null)).toBe(2048);
    expect(computeDropPosition(null, 1024)).toBe(0);
  });

  it('seeds an empty column with a constant', () => {
    expect(computeDropPosition(null, null)).toBe(1024);
  });
});
