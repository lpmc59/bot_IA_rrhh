const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'talindadb',
  user: process.env.DB_USER || 'talindadb_app',
  password: process.env.DB_PASSWORD || 'TalindA2020',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const SCHEMA = process.env.DB_SCHEMA || 'app';

pool.on('connect', (client) => {
  client.query(`SET search_path TO ${SCHEMA}, public`);
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`[DB] Slow query (${duration}ms):`, text.substring(0, 80));
  }
  return res;
}

async function getClient() {
  const client = await pool.connect();
  await client.query(`SET search_path TO ${SCHEMA}, public`);
  return client;
}

async function testConnection() {
  try {
    const res = await query('SELECT NOW() AS now');
    console.log('[DB] Connected OK:', res.rows[0].now);
    return true;
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    return false;
  }
}

module.exports = { pool, query, getClient, testConnection, SCHEMA };
