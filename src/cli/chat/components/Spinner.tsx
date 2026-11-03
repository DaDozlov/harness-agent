import { Text, useAnimation } from 'ink';
import { glyphs } from '../theme.js';

export function Spinner({ label }: { label?: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return (
    <Text color="cyan">
      {glyphs.spinner[frame % glyphs.spinner.length]}
      {label ? <Text dimColor> {label}</Text> : null}
    </Text>
  );
}
