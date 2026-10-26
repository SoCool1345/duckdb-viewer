export interface ColumnHighlight {
  schema: string;
  objectName: string;
  objectKind: 'table' | 'view';
  columnName: string;
}

export interface ObjectRef {
  schema: string;
  objectName: string;
  objectKind: 'table' | 'view';
}

export interface SelectedRef {
  schema: string;
  name: string;
  kind: 'table' | 'view';
}

export interface HighlightState {
  highlight: ColumnHighlight | null;
  /**
   * Column jumps whose `selectObject` request the host has not acknowledged
   * yet, oldest first. The last entry is always the current highlight target.
   */
  pendingJumps: ObjectRef[];
}

function isSelected(ref: ObjectRef, selected: SelectedRef | null): boolean {
  return (
    selected !== null &&
    selected.schema === ref.schema &&
    selected.name === ref.objectName &&
    selected.kind === ref.objectKind
  );
}

/**
 * Decides whether a column highlight survives a state push.
 *
 * A column jump emits `selectObject` and the host may push `busy: true` with
 * the *previous* selection before the new one arrives. That intermediate
 * state must not be mistaken for the user switching objects. Comparing the
 * selected object against the target alone is not enough either: when jumps
 * are issued back to back, a state for an earlier request can already carry
 * the latest target. Each state therefore acknowledges at most the oldest
 * pending request, and the highlight stays until those requests drain.
 */
export function reconcileHighlight(state: HighlightState, selected: SelectedRef | null): HighlightState {
  if (!state.highlight) return { highlight: null, pendingJumps: [] };

  if (state.pendingJumps.length === 0) {
    const target: ObjectRef = {
      schema: state.highlight.schema,
      objectName: state.highlight.objectName,
      objectKind: state.highlight.objectKind,
    };
    return isSelected(target, selected) ? state : { highlight: null, pendingJumps: [] };
  }

  const pendingJumps = state.pendingJumps.slice();
  const oldest = pendingJumps[0];
  if (oldest && isSelected(oldest, selected)) pendingJumps.shift();
  return { highlight: state.highlight, pendingJumps };
}

/** True while an IME composition is active; shortcuts must not react to it. */
export function isComposingEvent(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
