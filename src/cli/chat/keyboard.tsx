import { type Key, useInput, usePaste } from 'ink';
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef } from 'react';

export type KeyHandler = (input: string, key: Key) => void;
export type PasteHandler = (text: string) => void;

interface Listener {
  onKey: KeyHandler;
  onPaste?: PasteHandler | undefined;
}

interface KeyRouter {
  add(listener: { current: Listener }): () => void;
}

const KeyboardContext = createContext<KeyRouter | undefined>(undefined);

/**
 * Owns the only Ink input subscription and passes keys to registered components.
 *
 * Ink subscribes `useInput` in a passive effect, which React may run a moment after the component
 * appears; a key pressed in that gap (typing ahead, a quick "y" on an approval prompt) would be
 * lost. Here the subscription exists from the start, and components register in a layout effect,
 * which runs as part of the commit, so no key falls into a gap.
 */
export function KeyboardProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<{ current: Listener }>());
  useInput((input, key) => {
    for (const listener of [...listeners.current]) listener.current.onKey(input, key);
  });
  usePaste((text) => {
    for (const listener of [...listeners.current]) listener.current.onPaste?.(text);
  });
  const router = useMemo<KeyRouter>(
    () => ({
      add(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [],
  );
  return <KeyboardContext.Provider value={router}>{children}</KeyboardContext.Provider>;
}

/** Like Ink's `useInput` (plus paste), but registered without a gap. Needs a KeyboardProvider. */
export function useKeys(
  onKey: KeyHandler,
  options: { isActive?: boolean; onPaste?: PasteHandler } = {},
): void {
  const router = useContext(KeyboardContext);
  if (!router) throw new Error('useKeys needs a KeyboardProvider above it.');
  const latest = useRef<Listener>({ onKey, onPaste: options.onPaste });
  // Updated during commit, so the newest handlers are used without re-registering.
  useLayoutEffect(() => {
    latest.current = { onKey, onPaste: options.onPaste };
  });
  const isActive = options.isActive ?? true;
  useLayoutEffect(() => (isActive ? router.add(latest) : undefined), [router, isActive]);
}
