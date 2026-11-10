import { formatContact } from './format.js';

const list = document.getElementById('list');
const contacts = await (await fetch('/api/contacts')).json();
for (const contact of contacts) {
  const item = document.createElement('li');
  item.textContent = formatContact(contact);
  list.append(item);
}
