import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderReport } from './report.mjs';

const sales = JSON.parse(await readFile(new URL('../data/sales.json', import.meta.url), 'utf8'));
await mkdir(new URL('../out/', import.meta.url), { recursive: true });
await writeFile(new URL('../out/report.html', import.meta.url), renderReport(sales));
console.log('Wrote out/report.html');
