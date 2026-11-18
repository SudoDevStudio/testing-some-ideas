import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProducts } from '../src/products.js';

test('getProducts returns numeric prices even when a source price is a string', () => {
  const products = getProducts();
  assert.equal(products.length, 3);
  for (const product of products) {
    assert.equal(typeof product.price, 'number');
  }
  assert.equal(products.find((p) => p.id === 'monitor-001').price, 249.99);
  assert.equal(products.find((p) => p.id === 'keyboard-001').price, 79.99);
});
