const cron = require('node-cron');
const { Pool } = require('pg');
const logger = require('../utils/logger');
const { query: appQuery, SCHEMA } = require('../config/database');

// Connection to the talinda database (source of proveedores)
const talindaPool = new Pool({
  connectionString: process.env.TALINDA_DB_URL ||
    `postgresql://${process.env.DB_USER || 'talindadb_app'}:${process.env.DB_PASSWORD || 'TalindA2020'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/talinda`,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * Sync proveedores from talinda.public.proveedores to talindadb.app.proveedores
 */
async function syncProveedores() {
  let talindaClient;
  try {
    // Fetch all proveedores from source DB
    talindaClient = await talindaPool.connect();
    const { rows } = await talindaClient.query(
      'SELECT id, nombre, identificador, contacto, telefono, email, clasificacion, comentarios, direccion FROM public.proveedores ORDER BY id'
    );
    talindaClient.release();
    talindaClient = null;

    if (rows.length === 0) {
      logger.info('[ProveedoresSync] No proveedores found in source DB');
      return;
    }

    // Upsert into app.proveedores in talindadb
    let synced = 0;
    for (const p of rows) {
      await appQuery(
        `INSERT INTO ${SCHEMA}.proveedores
            (id, nombre, identificador, contacto, telefono, email, clasificacion, comentarios, direccion, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (id) DO UPDATE SET
            nombre = EXCLUDED.nombre,
            identificador = EXCLUDED.identificador,
            contacto = EXCLUDED.contacto,
            telefono = EXCLUDED.telefono,
            email = EXCLUDED.email,
            clasificacion = EXCLUDED.clasificacion,
            comentarios = EXCLUDED.comentarios,
            direccion = EXCLUDED.direccion,
            synced_at = NOW()`,
        [p.id, p.nombre, p.identificador, p.contacto, p.telefono, p.email, p.clasificacion, p.comentarios, p.direccion]
      );
      synced++;
    }

    logger.info(`[ProveedoresSync] Synced ${synced} proveedores OK`);
  } catch (err) {
    logger.error('[ProveedoresSync] Sync failed', { err: err.message });
    if (talindaClient) talindaClient.release();
  }
}

function startProveedoresSyncCron() {
  // Run every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    try {
      await syncProveedores();
    } catch (err) {
      logger.error('[ProveedoresSync] Cron failed', { err: err.message });
    }
  });

  // Also run once at startup
  syncProveedores().catch((err) => {
    logger.error('[ProveedoresSync] Initial sync failed', { err: err.message });
  });

  logger.info('[ProveedoresSync] Cron started (every 6 hours)');
}

module.exports = { startProveedoresSyncCron, syncProveedores };
