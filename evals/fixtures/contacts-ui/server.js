import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const contacts = [
  { name: 'Ada Lovelace', email: 'ada.lovelace@analytical-engines.example' },
  { name: 'Grace Hopper', email: 'grace.hopper@compilers.example' },
  { name: 'Katherine Johnson', email: 'katherine.johnson@orbits.example' },
];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

createServer(async (req, res) => {
  if (req.url === '/api/contacts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(contacts));
  }
  const path = req.url === '/' ? '/index.html' : req.url;
  try {
    const file = await readFile(new URL(`./public${path}`, import.meta.url));
    res.writeHead(200, { 'content-type': types[path.slice(path.lastIndexOf('.'))] ?? 'text/plain' });
    res.end(file);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(4391, () => console.log('Contacts running at http://localhost:4391'));
