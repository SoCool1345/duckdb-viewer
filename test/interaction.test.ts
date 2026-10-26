import { describe, expect, it } from 'vitest';
import {
  isComposingEvent,
  reconcileHighlight,
  type ColumnHighlight,
  type HighlightState,
  type ObjectRef,
} from '../src/webview/interaction';

const usersEmail: ColumnHighlight = {
  schema: 'main',
  objectName: 'users',
  objectKind: 'table',
  columnName: 'email',
};

const ordersColumn: ColumnHighlight = {
  schema: 'main',
  objectName: 'orders',
  objectKind: 'table',
  columnName: 'order_id',
};

const users: ObjectRef = { schema: 'main', objectName: 'users', objectKind: 'table' };
const orders: ObjectRef = { schema: 'main', objectName: 'orders', objectKind: 'table' };

const ordersSelected = { schema: 'main', name: 'orders', kind: 'table' as const };
const usersSelected = { schema: 'main', name: 'users', kind: 'table' as const };

function jumping(): HighlightState {
  return { highlight: usersEmail, pendingJumps: [{ ...users }] };
}

describe('reconcileHighlight', () => {
  it('keeps a pending jump while the host still reports the previous selection', () => {
    // The host pushes busy: true after selectObject but before switching.
    const next = reconcileHighlight(jumping(), ordersSelected);
    expect(next.highlight).toEqual(usersEmail);
    expect(next.pendingJumps).toEqual([users]);
  });

  it('keeps the highlight and clears the pending jump once the target is selected', () => {
    const next = reconcileHighlight(jumping(), usersSelected);
    expect(next.highlight).toEqual(usersEmail);
    expect(next.pendingJumps).toEqual([]);
  });

  it('does not clear the highlight on later pushes for the same object', () => {
    const settled = reconcileHighlight(jumping(), usersSelected);
    const next = reconcileHighlight(settled, usersSelected);
    expect(next.highlight).toEqual(usersEmail);
  });

  it('clears the highlight when the user selects another object after the jump', () => {
    const settled = reconcileHighlight(jumping(), usersSelected);
    const next = reconcileHighlight(settled, ordersSelected);
    expect(next.highlight).toBeNull();
  });

  it('keeps the latest highlight when two jumps overlap and complete in order', () => {
    // Current selection is orders: jump to users, then immediately back to orders.
    let state: HighlightState = {
      highlight: ordersColumn,
      pendingJumps: [{ ...users }, { ...orders }],
    };

    // The busy push still reports orders, but it acknowledges only the oldest request.
    state = reconcileHighlight(state, ordersSelected);
    expect(state.highlight).toEqual(ordersColumn);
    expect(state.pendingJumps).toEqual([users, orders]);

    // The first request (users) completes.
    state = reconcileHighlight(state, usersSelected);
    expect(state.highlight).toEqual(ordersColumn);
    expect(state.pendingJumps).toEqual([orders]);

    // The second request (orders) completes.
    state = reconcileHighlight(state, ordersSelected);
    expect(state.highlight).toEqual(ordersColumn);
    expect(state.pendingJumps).toEqual([]);

    // Only a later real switch clears it.
    state = reconcileHighlight(state, usersSelected);
    expect(state.highlight).toBeNull();
  });

  it('acknowledges at most one pending request per state push', () => {
    const pending = reconcileHighlight(
      { highlight: usersEmail, pendingJumps: [{ ...users }, { ...users }] },
      usersSelected,
    );
    expect(pending.pendingJumps).toEqual([users]);
    expect(pending.highlight).toEqual(usersEmail);
  });

  it('clears the highlight when no object is selected and no jump is pending', () => {
    const next = reconcileHighlight({ highlight: usersEmail, pendingJumps: [] }, null);
    expect(next.highlight).toBeNull();
  });

  it('keeps a pending jump even if the selection is temporarily empty', () => {
    const next = reconcileHighlight(jumping(), null);
    expect(next.highlight).toEqual(usersEmail);
    expect(next.pendingJumps).toEqual([users]);
  });

  it('drops pending jumps that have no highlight', () => {
    expect(reconcileHighlight({ highlight: null, pendingJumps: [{ ...orders }] }, null)).toEqual({
      highlight: null,
      pendingJumps: [],
    });
  });

  it('treats a same-named object in another kind as a different target', () => {
    const next = reconcileHighlight(jumping(), { schema: 'main', name: 'users', kind: 'view' });
    expect(next.highlight).toEqual(usersEmail);
    expect(next.pendingJumps).toEqual([users]);
  });
});

describe('isComposingEvent', () => {
  it('ignores keys pressed while confirming an IME candidate', () => {
    expect(isComposingEvent({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isComposingEvent({ keyCode: 229 })).toBe(true);
  });

  it('lets normal key presses through', () => {
    expect(isComposingEvent({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isComposingEvent({})).toBe(false);
  });
});
