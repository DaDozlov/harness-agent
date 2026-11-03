import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useEffect, useState } from 'react';
import { expect, it } from 'vitest';
import { KeyboardProvider, useKeys } from '../../src/cli/chat/keyboard.js';

function Late({ onKey }: { onKey: (input: string) => void }) {
  useKeys((input) => onKey(input));
  return <Text>ready</Text>;
}

function Parent({ onKey }: { onKey: (input: string) => void }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 30);
    return () => clearTimeout(timer);
  }, []);
  return show ? <Late onKey={onKey} /> : <Text>waiting</Text>;
}

it('delivers a key pressed the moment a late component appears', async () => {
  const received: string[] = [];
  const ui = render(
    <KeyboardProvider>
      <Parent onKey={(input) => received.push(input)} />
    </KeyboardProvider>,
  );

  // Press as soon as the component is on screen, with no grace period.
  while (ui.lastFrame() !== 'ready') await new Promise((resolve) => setTimeout(resolve, 1));
  ui.stdin.write('y');
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(received).toEqual(['y']);
  ui.unmount();
});

it('passes pasted text to paste handlers, not key handlers', async () => {
  const keys: string[] = [];
  const pastes: string[] = [];
  function Input() {
    useKeys((input) => keys.push(input), { onPaste: (text) => pastes.push(text) });
    return <Text>input</Text>;
  }
  const ui = render(
    <KeyboardProvider>
      <Input />
    </KeyboardProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  ui.stdin.write('\u001b[200~line one\nline two\u001b[201~');
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(pastes).toEqual(['line one\nline two']);
  expect(keys).toEqual([]);
  ui.unmount();
});
