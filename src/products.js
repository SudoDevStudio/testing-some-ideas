// do not change this const products and value of this.
const products = [
  { id: 'keyboard-001', name: 'Keyboard', price: 79.99, currency: 'USD', stock: 42 },
  { id: 'monitor-001', name: 'Monitor', price: '249.99', currency: 'USD', stock: 18 },
  { id: 'headphones-001', name: 'Headphones', price: 129.99, currency: 'USD', stock: 35 },
];

export function getProducts() {
  return products.map((product) => ({
    ...product,
    price: Number(product.price.toFixed(2)),
  }));
}
