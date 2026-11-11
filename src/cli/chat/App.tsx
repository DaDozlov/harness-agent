import { Box, Static, Text, useApp, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ApprovalDecision } from '../../core/events.js';
import type { PermissionMode } from '../../core/permissions.js';
import type { Session } from '../../core/session.js';
import type { Engine } from '../../engine.js';
import { VERSION } from '../../version.js';
import { type CommandContext, matchCommands, runSlashCommand } from './commands.js';
import { type EngineFactory, reloadChat } from './reload.js';
import { type ApprovalRequestEvent, ApprovalPrompt } from './components/ApprovalPrompt.js';
import { ItemView } from './components/ItemView.js';
import { PromptInput } from './components/PromptInput.js';
import { Spinner } from './components/Spinner.js';
import { StatusBar } from './components/StatusBar.js';
import { EMPTY_INPUT, fromText } from './input-buffer.js';
import { KeyboardProvider, useKeys } from './keyboard.js';
import { fitLiveArea } from './live-area.js';
import { approvalPreview } from './preview.js';
import { glyphs } from './theme.js';
import {
  createTranscript,
  hookAgentRunning,
  itemsFromHistory,
  type TranscriptItem,
  transcriptReducer,
} from './transcript.js';
import { useEditableBuffer } from './use-buffer.js';

/** Shift+Tab cycles through these. Bypass is only reachable with /mode, on purpose. */
const MODE_CYCLE: PermissionMode[] = ['default', 'accept-edits', 'read-only'];

/** Screen rows kept free below streaming text: input box, status bar and spacing. */
const RESERVED_ROWS = 8;

export interface AppProps {
  engine: Engine;
  session: Session;
  /** Shown above the transcript when a saved conversation was resumed. */
  resumed?: boolean;
  /** Called whenever the chat switches to another session (e.g. /clear). */
  onSessionChange?: (session: Session) => void;
  /** Builds an engine from the config files as they are now, for `/reload`. */
  reloadEngine?: EngineFactory;
  /** Setup files changed since the last load: applied before the next message, and after a run. */
  setupChanges?: () => Promise<string[]>;
  /** Called when `/reload` replaced the engine. */
  onEngineChange?: (engine: Engine) => void;
}

/** The interactive chat (docs/DESIGN.md §4.15): one consumer of the engine's event stream. */
export function App(props: AppProps) {
  return (
    <KeyboardProvider>
      <ChatApp {...props} />
    </KeyboardProvider>
  );
}

function ChatApp({
  engine: initialEngine,
  session: initialSession,
  resumed = false,
  onSessionChange,
  reloadEngine,
  setupChanges,
  onEngineChange,
}: AppProps) {
  const { exit } = useApp();
  const sessionRef = useRef(initialSession);
  const [session, setSession] = useState(initialSession);
  // `/reload` replaces the engine.
  const engineRef = useRef(initialEngine);
  const [engine, setEngine] = useState(initialEngine);
  const [transcript, dispatch] = useReducer(transcriptReducer, undefined, () =>
    createTranscript(
      initialSession.usage,
      initialItems(engine, initialSession, resumed),
      initialSession.costUsd,
    ),
  );
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  // Parallel sub-agents can ask at the same time: answered one after the other, none lost.
  const [approvals, setApprovals] = useState<ApprovalRequestEvent[]>([]);
  const approval = approvals[0];
  const [exitArmed, setExitArmed] = useState(false);
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const input = useEditableBuffer();
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!exitArmed) return;
    const timer = setTimeout(() => setExitArmed(false), 2_000);
    return () => clearTimeout(timer);
  }, [exitArmed]);

  // MCP servers connect in the background; redraw the status bar when one changes.
  useEffect(() => engine.onMcpChange(refresh), [engine]);

  const print = useCallback(
    (text: string, tone: 'info' | 'warning' | 'error' = 'info') =>
      dispatch({ type: 'notice', text, tone }),
    [],
  );

  const quit = useCallback(() => {
    abortRef.current?.abort();
    exit();
  }, [exit]);

  const switchSession = useCallback(
    (next: Session) => {
      sessionRef.current = next;
      setSession(next);
      onSessionChange?.(next);
      dispatch({ type: 'usage', usage: next.usage, costUsd: next.costUsd });
    },
    [onSessionChange],
  );

  const reload = useCallback(async () => {
    if (!reloadEngine) throw new Error('Reloading is not available here; restart heaw instead.');
    const result = await reloadChat(
      { engine: engineRef.current, session: sessionRef.current },
      reloadEngine,
    );
    engineRef.current = result.engine;
    setEngine(result.engine);
    onEngineChange?.(result.engine);
    switchSession(result.session);
    return result.text;
  }, [reloadEngine, onEngineChange, switchSession]);

  /** Applies setup files that changed (by the agent, or in an editor) since they were loaded. */
  const applySetupChanges = useCallback(async () => {
    const changed = reloadEngine && setupChanges ? await setupChanges() : [];
    if (!changed.length) return;
    const files = changed.join(', ');
    try {
      print(`${files} changed, so heaw applied the setup again.\n${await reload()}`);
    } catch (error) {
      print(
        `${files} changed, but the setup does not load: ` +
          `${error instanceof Error ? error.message : String(error)}\n` +
          'heaw keeps the previous setup. Fix it, then type /reload.',
        'warning',
      );
    }
  }, [reload, reloadEngine, setupChanges, print]);

  const send = useCallback(
    async (text: string, show = true) => {
      if (show) dispatch({ type: 'user', text });
      runningRef.current = true;
      setRunning(true);
      try {
        await applySetupChanges();
        const controller = new AbortController();
        abortRef.current = controller;
        for await (const event of sessionRef.current.send(text, { signal: controller.signal })) {
          dispatch({ type: 'event', event });
          if (event.type === 'approval.request') setApprovals((queue) => [...queue, event]);
          // Answered here, or let through by an answer "for the session" to another request.
          if (event.type === 'approval.response') {
            setApprovals((queue) => queue.filter((item) => item.requestId !== event.requestId));
          }
        }
      } catch (error) {
        dispatch({
          type: 'notice',
          tone: 'error',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        abortRef.current = undefined;
        setApprovals([]);
        // What the run changed, e.g. the config /setup wrote, applies from the next message on.
        await applySetupChanges();
        runningRef.current = false;
        setRunning(false);
      }
    },
    [applySetupChanges],
  );

  const commandContext = useMemo<CommandContext>(
    () => ({
      engine,
      session: () => sessionRef.current,
      print,
      refresh,
      exit: quit,
      send: (text) => void send(text, false),
      ...(reloadEngine && { reload }),
      newSession: () => {
        const previous = sessionRef.current;
        const next = engine.session();
        next.permissions.setMode(previous.permissions.mode);
        switchSession(next);
        print(`New conversation (session ${next.id}). The previous one is saved.`);
        // Runs its sessionEnd hooks.
        void previous.close().then((failures) => {
          for (const failure of failures) {
            print(`The ${failure.hook} hook failed: ${failure.message}`, 'warning');
          }
        });
      },
    }),
    [engine, print, quit, send, switchSession, reload, reloadEngine],
  );

  const onEnter = () => {
    const { text, cursor } = input.current();
    // A trailing backslash continues the message on a new line.
    if (text.endsWith('\\') && cursor === text.length) {
      input.edit((current) => ({
        text: `${current.text.slice(0, -1)}\n`,
        cursor: current.text.length,
      }));
      return;
    }
    const message = text.trim();
    if (!message) return;
    if (runningRef.current) {
      print('Wait for the current answer, or press Esc to interrupt it.', 'warning');
      return;
    }
    history.current.push(message);
    historyIndex.current = undefined;
    input.edit(() => EMPTY_INPUT);
    if (message.startsWith('/')) {
      dispatch({ type: 'user', text: message });
      runSlashCommand(message, commandContext).catch((error: unknown) =>
        print(`Error: ${error instanceof Error ? error.message : String(error)}`, 'error'),
      );
    } else {
      void send(message);
    }
  };

  const onHistory = (direction: -1 | 1) => {
    const entries = history.current;
    if (!entries.length) return;
    const index = Math.max(
      0,
      Math.min(entries.length, (historyIndex.current ?? entries.length) + direction),
    );
    historyIndex.current = index;
    input.edit(() => fromText(entries[index] ?? ''));
  };

  const onTab = () => {
    const [match] = matchCommands(input.current().text);
    if (match) input.edit(() => fromText(`/${match.name} `));
  };

  const answer = (decision: ApprovalDecision) => {
    if (!approval) return;
    setApprovals((queue) => queue.filter((item) => item.requestId !== approval.requestId));
    sessionRef.current.approve(approval.requestId, decision);
  };

  useKeys((char, key) => {
    if (key.ctrl && char === 'c') {
      if (runningRef.current) return abortRef.current?.abort();
      if (input.current().text) return input.edit(() => EMPTY_INPUT);
      if (exitArmed) return quit();
      return setExitArmed(true);
    }
    if (key.ctrl && char === 'd' && !runningRef.current && !input.current().text) return quit();
    if (key.escape && runningRef.current && !approval) return abortRef.current?.abort();
    if (key.shift && key.tab) {
      const permissions = sessionRef.current.permissions;
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(permissions.mode) + 1) % MODE_CYCLE.length]!;
      permissions.setMode(next);
      refresh();
    }
  });

  const committed = transcript.items.slice(0, transcript.committed);
  const live = transcript.items.slice(transcript.committed);
  const last = transcript.items.at(-1);
  const busy = last?.kind === 'tool' && last.status === 'running';
  const streaming = last?.kind === 'assistant' && !last.done;
  const checking = hookAgentRunning(transcript);
  const suggestions = approval ? [] : matchCommands(input.buffer.text);
  const { rows, columns } = useWindowSize();
  const space = { rows: Math.max(4, rows - RESERVED_ROWS), columns: Math.max(20, columns - 2) };
  const layout = fitLiveArea(
    live,
    space,
    approval && {
      previewLines: approvalPreview(approval.tool, approval.args).length,
      waiting: approvals.length - 1,
    },
  );

  return (
    <Box flexDirection="column">
      <Static items={committed}>
        {(item, index) => <ItemView key={item.id} item={item} previous={committed[index - 1]} />}
      </Static>
      {layout.items.map((item, index) => (
        <ItemView
          key={item.id}
          item={item}
          previous={index === 0 ? committed.at(-1) : layout.items[index - 1]}
          space={space}
          compact={layout.compact}
        />
      ))}
      {layout.hidden ? (
        <Box paddingLeft={2}>
          <Text dimColor>
            … {layout.hidden} more {layout.hidden === 1 ? 'call' : 'calls'} running
          </Text>
        </Box>
      ) : null}
      {running && !approval && !busy && !streaming ? (
        <Box marginTop={1}>
          <Spinner
            label={checking ? `${checking.label} is checking… (Esc to stop)` : 'Thinking…'}
          />
        </Box>
      ) : null}
      {approval ? (
        <ApprovalPrompt
          key={approval.requestId}
          request={approval}
          agent={
            approval.parentAgentId === undefined
              ? undefined
              : (transcript.agents[approval.agentId]?.label ?? approval.agentId)
          }
          onAnswer={answer}
          maxPreviewLines={layout.previewLines}
          waiting={approvals.length - 1}
        />
      ) : (
        <Box borderStyle={glyphs.border} borderColor="gray" paddingX={1} marginTop={1}>
          <PromptInput
            buffer={input.buffer}
            edit={input.edit}
            onEnter={onEnter}
            onHistory={onHistory}
            onTab={onTab}
            isActive={!approval}
            placeholder={
              running
                ? 'heaw is working… (Esc to interrupt)'
                : 'Ask heaw to do something, or type / for commands'
            }
          />
        </Box>
      )}
      {suggestions.length ? (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.map((command) => (
            <Text key={command.name} dimColor>
              /{command.name} {command.usage ?? ''} <Text dimColor>— {command.description}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <StatusBar
        model={session.model.id}
        mode={session.permissions.mode}
        plan={session.inPlanMode}
        usage={transcript.usage}
        costUsd={transcript.costUsd}
        context={session.contextUsage()}
        sessionId={session.id}
        running={running}
        exitArmed={exitArmed}
        mcp={mcpSummary(engine)}
      />
    </Box>
  );
}

function initialItems(engine: Engine, session: Session, resumed: boolean): TranscriptItem[] {
  const banner: TranscriptItem = {
    kind: 'notice',
    id: 'banner',
    tone: 'info',
    text: `heaw ${VERSION} · ${session.model.id} · ${engine.workspace.root}\n/help for commands · Shift+Tab to switch mode · Esc to interrupt`,
  };
  if (!resumed) return [banner];
  return [
    banner,
    ...itemsFromHistory(session.messages),
    {
      kind: 'notice',
      id: 'resumed',
      tone: 'info',
      text: `Resumed session ${session.id} (${session.messages.length} messages). Files must be read again before they can be changed.`,
    },
  ];
}

function mcpSummary(engine: Engine) {
  const servers = engine.mcpServers().filter((server) => server.status !== 'disabled');
  return {
    connected: servers.filter((server) => server.status === 'connected').length,
    total: servers.length,
    failed: servers.filter(
      (server) => server.status === 'failed' || server.status === 'needs-login',
    ).length,
  };
}
