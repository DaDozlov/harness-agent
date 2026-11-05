import { Text, useApp } from 'ink';
import { useState } from 'react';
import type { Session } from '../../core/session.js';
import type { SessionSummary } from '../../core/session-store.js';
import type { Engine } from '../../engine.js';
import { App } from './App.js';
import { SessionPicker } from './components/SessionPicker.js';
import { KeyboardProvider } from './keyboard.js';
import type { EngineFactory } from './reload.js';

export type ChatStart =
  | { kind: 'session'; session: Session; resumed: boolean }
  | { kind: 'pick'; sessions: SessionSummary[] };

/** Shows the session picker first when asked to, then the chat. */
export function ChatRoot({
  engine,
  start,
  onSessionChange,
  reloadEngine,
  setupChanges,
  onEngineChange,
}: {
  engine: Engine;
  start: ChatStart;
  onSessionChange: (session: Session) => void;
  reloadEngine?: EngineFactory;
  setupChanges?: () => Promise<string[]>;
  onEngineChange?: (engine: Engine) => void;
}) {
  const { exit } = useApp();
  const [chat, setChat] = useState(start.kind === 'session' ? start : undefined);
  const [error, setError] = useState<string>();

  if (chat) {
    return (
      <App
        engine={engine}
        session={chat.session}
        resumed={chat.resumed}
        onSessionChange={onSessionChange}
        {...(reloadEngine && { reloadEngine })}
        {...(setupChanges && { setupChanges })}
        {...(onEngineChange && { onEngineChange })}
      />
    );
  }
  if (error) return <Text color="red">{error}</Text>;

  const begin = (session: Session, resumed: boolean) => {
    onSessionChange(session);
    setChat({ kind: 'session', session, resumed });
  };
  return (
    <KeyboardProvider>
      <SessionPicker
        sessions={start.kind === 'pick' ? start.sessions : []}
        onPick={(id) => {
          engine.resume(id).then(
            (session) => begin(session, true),
            (cause: unknown) => {
              setError(
                `Could not resume ${id}: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
              exit();
            },
          );
        }}
        onCancel={() => begin(engine.session(), false)}
      />
    </KeyboardProvider>
  );
}
