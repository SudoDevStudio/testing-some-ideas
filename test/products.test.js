import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProducts } from '../src/products.js';

test('getProducts returns numeric prices for numeric and string source prices', () => {
  const products = getProducts();
  assert.deepEqual(products.map(({ id, price }) => ({ id, price })), [
    { id: 'keyboard-001', price: 79.99 },
    { id: 'monitor-001', price: 249.99 },
    { id: 'headphones-001', price: 129.99 },
  ]);
});
