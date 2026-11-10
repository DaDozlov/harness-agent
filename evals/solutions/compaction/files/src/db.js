/**
 * The orders table, shared with the warehouse system: its column names must not change.
 *
 * CREATE TABLE orders (
 *   id INTEGER PRIMARY KEY,
 *   customer_name TEXT NOT NULL,
 *   city TEXT NOT NULL,
 *   total_cents INTEGER NOT NULL,
 *   ordered_on TEXT NOT NULL
 * );
 */
export const COLUMNS = ['id', 'customer_name', 'city', 'total_cents', 'ordered_on'];

/** Rows to start a test database with: id, customer_name, city, total_cents, ordered_on. */
export const SEED_ROWS = [
  [1, 'Ada Lovelace', 'Berlin', 1500, '2026-01-01'],
  [2, 'Grace Hopper', 'Hamburg', 1811, '2026-02-02'],
  [3, 'Alan Turing', 'Munich', 2122, '2026-03-03'],
  [4, 'Katherine Johnson', 'Cologne', 2433, '2026-04-04'],
  [5, 'Edsger Dijkstra', 'Frankfurt', 2744, '2026-05-05'],
  [6, 'Barbara Liskov', 'Stuttgart', 3055, '2026-06-06'],
  [7, 'Donald Knuth', 'Leipzig', 3366, '2026-07-07'],
  [8, 'Margaret Hamilton', 'Dresden', 3677, '2026-08-08'],
  [9, 'Ada Lovelace', 'Hanover', 3988, '2026-09-09'],
  [10, 'Grace Hopper', 'Nuremberg', 4299, '2026-01-10'],
  [11, 'Alan Turing', 'Bremen', 4610, '2026-02-11'],
  [12, 'Katherine Johnson', 'Essen', 4921, '2026-03-12'],
  [13, 'Edsger Dijkstra', 'Berlin', 5232, '2026-04-13'],
  [14, 'Barbara Liskov', 'Hamburg', 5543, '2026-05-14'],
  [15, 'Donald Knuth', 'Munich', 5854, '2026-06-15'],
  [16, 'Margaret Hamilton', 'Cologne', 6165, '2026-07-16'],
  [17, 'Ada Lovelace', 'Frankfurt', 6476, '2026-08-17'],
  [18, 'Grace Hopper', 'Stuttgart', 6787, '2026-09-18'],
  [19, 'Alan Turing', 'Leipzig', 7098, '2026-01-19'],
  [20, 'Katherine Johnson', 'Dresden', 7409, '2026-02-20'],
  [21, 'Edsger Dijkstra', 'Hanover', 7720, '2026-03-21'],
  [22, 'Barbara Liskov', 'Nuremberg', 8031, '2026-04-22'],
  [23, 'Donald Knuth', 'Bremen', 8342, '2026-05-23'],
  [24, 'Margaret Hamilton', 'Essen', 8653, '2026-06-24'],
  [25, 'Ada Lovelace', 'Berlin', 8964, '2026-07-25'],
  [26, 'Grace Hopper', 'Hamburg', 9275, '2026-08-26'],
  [27, 'Alan Turing', 'Munich', 9586, '2026-09-27'],
  [28, 'Katherine Johnson', 'Cologne', 9897, '2026-01-01'],
  [29, 'Edsger Dijkstra', 'Frankfurt', 10208, '2026-02-02'],
  [30, 'Barbara Liskov', 'Stuttgart', 10519, '2026-03-03'],
  [31, 'Donald Knuth', 'Leipzig', 10830, '2026-04-04'],
  [32, 'Margaret Hamilton', 'Dresden', 11141, '2026-05-05'],
  [33, 'Ada Lovelace', 'Hanover', 11452, '2026-06-06'],
  [34, 'Grace Hopper', 'Nuremberg', 11763, '2026-07-07'],
  [35, 'Alan Turing', 'Bremen', 12074, '2026-08-08'],
  [36, 'Katherine Johnson', 'Essen', 12385, '2026-09-09'],
  [37, 'Edsger Dijkstra', 'Berlin', 12696, '2026-01-10'],
  [38, 'Barbara Liskov', 'Hamburg', 13007, '2026-02-11'],
  [39, 'Donald Knuth', 'Munich', 13318, '2026-03-12'],
  [40, 'Margaret Hamilton', 'Cologne', 13629, '2026-04-13'],
  [41, 'Ada Lovelace', 'Frankfurt', 13940, '2026-05-14'],
  [42, 'Grace Hopper', 'Stuttgart', 14251, '2026-06-15'],
  [43, 'Alan Turing', 'Leipzig', 14562, '2026-07-16'],
  [44, 'Katherine Johnson', 'Dresden', 14873, '2026-08-17'],
  [45, 'Edsger Dijkstra', 'Hanover', 15184, '2026-09-18'],
  [46, 'Barbara Liskov', 'Nuremberg', 15495, '2026-01-19'],
  [47, 'Donald Knuth', 'Bremen', 15806, '2026-02-20'],
  [48, 'Margaret Hamilton', 'Essen', 16117, '2026-03-21'],
  [49, 'Ada Lovelace', 'Berlin', 16428, '2026-04-22'],
  [50, 'Grace Hopper', 'Hamburg', 16739, '2026-05-23'],
  [51, 'Alan Turing', 'Munich', 17050, '2026-06-24'],
  [52, 'Katherine Johnson', 'Cologne', 17361, '2026-07-25'],
  [53, 'Edsger Dijkstra', 'Frankfurt', 17672, '2026-08-26'],
  [54, 'Barbara Liskov', 'Stuttgart', 17983, '2026-09-27'],
  [55, 'Donald Knuth', 'Leipzig', 18294, '2026-01-01'],
  [56, 'Margaret Hamilton', 'Dresden', 18605, '2026-02-02'],
  [57, 'Ada Lovelace', 'Hanover', 18916, '2026-03-03'],
  [58, 'Grace Hopper', 'Nuremberg', 19227, '2026-04-04'],
  [59, 'Alan Turing', 'Bremen', 19538, '2026-05-05'],
  [60, 'Katherine Johnson', 'Essen', 19849, '2026-06-06'],
  [61, 'Edsger Dijkstra', 'Berlin', 20160, '2026-07-07'],
  [62, 'Barbara Liskov', 'Hamburg', 20471, '2026-08-08'],
  [63, 'Donald Knuth', 'Munich', 20782, '2026-09-09'],
  [64, 'Margaret Hamilton', 'Cologne', 21093, '2026-01-10'],
  [65, 'Ada Lovelace', 'Frankfurt', 21404, '2026-02-11'],
  [66, 'Grace Hopper', 'Stuttgart', 21715, '2026-03-12'],
  [67, 'Alan Turing', 'Leipzig', 22026, '2026-04-13'],
  [68, 'Katherine Johnson', 'Dresden', 22337, '2026-05-14'],
  [69, 'Edsger Dijkstra', 'Hanover', 22648, '2026-06-15'],
  [70, 'Barbara Liskov', 'Nuremberg', 22959, '2026-07-16'],
];

/** A database row as the app's order summary. */
export function rowToOrder(row) {
  return {
    id: row.id,
    buyerName: row.customer_name,
    city: row.city,
    totalCents: row.total_cents,
    orderedOn: row.ordered_on,
  };
}

/** The app's order summary as a database row. */
export function orderToRow(order) {
  return {
    id: order.id,
    customer_name: order.buyerName,
    city: order.city,
    total_cents: order.totalCents,
    ordered_on: order.orderedOn,
  };
}

/** The INSERT statement for a summary, with its parameters. */
export function insertSql(order) {
  const row = orderToRow(order);
  return {
    sql: `INSERT INTO orders (${COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?)`,
    params: COLUMNS.map((column) => row[column]),
  };
}
