'use strict';

const axios = require('axios');

function apiClient(token, timezone) {
  const instance = axios.create({
    baseURL: 'http://localhost:3000',
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  // Interceptor para inserir X-Timezone em todas as requisições
  instance.interceptors.request.use((config) => {
    const tz = timezone || process.env.TZ || 'UTC';
    if (!config.headers) config.headers = {};
    config.headers['X-Timezone'] = tz;
    return config;
  });
  return instance;
}

module.exports = { apiClient };


