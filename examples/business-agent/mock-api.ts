/**
 * A stand-in for the shop's API, so the example runs without one: node mock-api.ts
 * Data is in memory and reset on restart.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';

const PORT = 4010;
const TOKEN = process.env.SHOP_API_TOKEN ?? 'dev-token';
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const customers = [{ id: 'c-1001', name: 'Ana Silva', email: 'ana@example.com' }];
const orders = [
  {
    id: 'NW-5001',
    customerId: 'c-1001',
    status: 'delivered',
    items: [{ sku: 'HP-200', name: 'Studio headphones', price: 89 }],
    shipping: 4.9,
    deliveredAt: daysAgo(12),
  },
  {
    id: 'NW-5002',
    customerId: 'c-1001',
    status: 'delayed',
    items: [{ sku: 'SP-900', name: 'Bookshelf speakers', price: 240 }],
    shipping: 0,
    shippedAt: daysAgo(6),
    shipment: { carrier: 'DHL', tracking: 'JD0146000033', estimatedDelivery: daysAgo(-9) },
  },
  {
    id: 'NW-4870',
    customerId: 'c-1001',
    status: 'delivered',
    items: [{ sku: 'CB-010', name: 'Audio cable', price: 12 }],
    shipping: 4.9,
    deliveredAt: daysAgo(64),
  },
];
const refunds: { id: string; orderId: string; sku: string; amount: number; reason: string }[] = [];

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body, null, 2));
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
  console.log(request.method, url.pathname + url.search);
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    send(response, 401, { error: 'unauthorized' });
    return;
  }
  const [, resource, id, sub] = url.pathname.split('/');

  if (request.method === 'GET' && resource === 'customers' && !id) {
    const email = url.searchParams.get('email')?.toLowerCase();
    send(
      response,
      200,
      customers.filter((customer) => customer.email === email),
    );
  } else if (request.method === 'GET' && resource === 'customers' && sub === 'orders') {
    send(
      response,
      200,
      orders.filter((order) => order.customerId === id),
    );
  } else if (request.method === 'GET' && resource === 'orders' && id) {
    const order = orders.find((candidate) => candidate.id === id);
    if (order) send(response, 200, order);
    else send(response, 404, { error: `no order ${id}` });
  } else if (request.method === 'GET' && resource === 'refunds') {
    send(
      response,
      200,
      refunds.filter((refund) => refund.orderId === url.searchParams.get('orderId')),
    );
  } else if (request.method === 'POST' && resource === 'refunds') {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const refund = JSON.parse(body || '{}') as Omit<(typeof refunds)[number], 'id'>;
      const order = orders.find((candidate) => candidate.id === refund.orderId);
      const item = order?.items.find((candidate) => candidate.sku === refund.sku);
      if (!order || !item) send(response, 422, { error: 'unknown order or sku' });
      else if (refund.amount > item.price + order.shipping)
        send(response, 422, { error: 'amount too high' });
      else {
        const created = { ...refund, id: `R-${randomUUID().slice(0, 8)}`, status: 'pending' };
        refunds.push(created);
        send(response, 201, created);
      }
    });
  } else {
    send(response, 404, { error: 'not found' });
  }
}).listen(PORT, () => console.log(`Shop API on http://localhost:${PORT} (token: SHOP_API_TOKEN)`));
