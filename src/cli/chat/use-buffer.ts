import { useCallback, useRef, useState } from 'react';
import { EMPTY_INPUT, type InputBuffer } from './input-buffer.js';

/**
 * Input state that stays correct when keys arrive faster than React renders: edits apply to the
 * latest value (kept in a ref), and the state copy drives rendering.
 */
export function useEditableBuffer() {
  const latest = useRef<InputBuffer>(EMPTY_INPUT);
  const [buffer, setBuffer] = useState<InputBuffer>(EMPTY_INPUT);
  const edit = useCallback((update: (current: InputBuffer) => InputBuffer) => {
    const next = update(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    setBuffer(next);
  }, []);
  const current = useCallback(() => latest.current, []);
  return { buffer, edit, current };
}
