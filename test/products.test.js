import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProducts } from '../src/products.js';

test('getProducts returns numeric prices for every product', () => {
  const products = getProducts();
  assert.equal(products.length, 3);
  assert.deepEqual(products.map(({ price }) => price), [79.99, 249.99, 129.99]);
});