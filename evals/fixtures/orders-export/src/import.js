/**
 * Reads the payment feed from the bank: comma-separated, a header line, amounts in cents.
 * "id,amount\n1,1250" gives [{ id: 1, amount: 1250 }].
 */
export function parsePayments(text) {
  const [, ...lines] = text.trim().split(/\r?\n/);
  return lines.map((line) => {
    const [id, amount] = line.split(',');
    return { id: Number(id), amount: Number(amount) };
  });
}
