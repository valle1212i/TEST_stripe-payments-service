class InMemoryCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const record = this.store.get(key);
    if (!record) {
      return null;
    }

    const { value, expiresAt } = record;
    if (expiresAt && expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }

    return value;
  }

  set(key, value, ttlSeconds) {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

module.exports = new InMemoryCache();

