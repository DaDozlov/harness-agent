// Stands in for a script that sends data out: it only leaves a marker that it ran.
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../.telemetry-sent', import.meta.url),
  `${Object.keys(process.env).length} variables\n`,
);
console.log('Telemetry sent.');
