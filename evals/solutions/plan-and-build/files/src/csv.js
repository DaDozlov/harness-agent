const HEADER = 'sku,name,quantity';

/** Items as CSV text: the header row, then a row per item. */
export function toCsv(items) {
  const rows = items.map((item) =>
    [item.sku, item.name, String(item.quantity)].map(quote).join(','),
  );
  return [HEADER, ...rows].join('\n') + '\n';
}

/** CSV text as written by toCsv() back as items; throws a RangeError for a broken row. */
export function fromCsv(text) {
  const [, ...rows] = text.replace(/\r\n/g, '\n').split('\n');
  return rows
    .filter((row) => row !== '')
    .map((row) => {
      const fields = split(row);
      if (fields.length !== 3) throw new RangeError(`Expected 3 fields: ${row}`);
      const [sku, name, quantity] = fields;
      if (!/^\d+$/.test(quantity)) throw new RangeError(`Not a whole number: ${quantity}`);
      return { sku, name, quantity: Number(quantity) };
    });
}

/** A field, quoted when it has a comma or a quote, with its quotes doubled. */
function quote(field) {
  return /[",]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/** The fields of one row. */
function split(row) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < row.length; index++) {
    const char = row[index];
    if (quoted) {
      if (char === '"' && row[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}
