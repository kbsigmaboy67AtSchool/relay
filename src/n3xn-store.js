export class N3xnStoreClient {
  constructor(transport) {
    this.transport = transport;
  }

  // Cloudflare KV
  async kvGet(key, target = 'primary') {
    return await this.transport.rpc('CF_KV_GET', { key, target });
  }

  async kvSet(key, value, target = 'primary', ttl = null) {
    return await this.transport.rpc('CF_KV_SET', { key, value, target, ttl });
  }

  // Cloudflare D1 Serverless SQL
  async sqlQuery(query, params = []) {
    return await this.transport.rpc('CF_D1_QUERY', { query, params, isExec: false });
  }

  async sqlExec(query, params = []) {
    return await this.transport.rpc('CF_D1_QUERY', { query, params, isExec: true });
  }

  // Cloudflare R2 Object Storage
  async r2Put(key, content) {
    return await this.transport.rpc('CF_R2_PUT', { key, data: content });
  }

  async r2Get(key) {
    return await this.transport.rpc('CF_R2_GET', { key });
  }

  // GitHub Git KV Proxy
  async gitSet(key, value) {
    return await this.transport.rpc('GIT_KV_SET', { key, value });
  }
}
