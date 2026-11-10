/** An inventory: items by sku. An item is `{ sku, name, quantity }`. */
export function createInventory(items = []) {
  const bySku = new Map();
  for (const item of items) bySku.set(item.sku, check(item));

  return {
    /** Adds an item, or adds its quantity to the item that has this sku already. */
    add(item) {
      const known = bySku.get(check(item).sku);
      if (known) known.quantity += item.quantity;
      else bySku.set(item.sku, { ...item });
    },

    /** Takes `quantity` of an item out; throws when there is not enough of it. */
    take(sku, quantity) {
      const item = bySku.get(sku);
      if (!item || item.quantity < quantity) throw new RangeError(`Not enough of ${sku}.`);
      item.quantity -= quantity;
    },

    /** The items, sorted by sku. */
    items() {
      return [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku));
    },
  };
}

function check(item) {
  if (typeof item.sku !== 'string' || !item.sku) throw new RangeError('An item needs a sku.');
  if (typeof item.name !== 'string') throw new RangeError('An item needs a name.');
  if (!Number.isInteger(item.quantity) || item.quantity < 0) {
    throw new RangeError('A quantity is a whole number, zero or more.');
  }
  return item;
}
