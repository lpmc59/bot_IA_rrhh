/**
 * Fecha y hora local de Guatemala (UTC-6).
 *
 * IMPORTANTE: new Date().toISOString() devuelve fecha UTC.
 * A las 18:01 CST del viernes, toISOString() ya da sábado en UTC.
 * Esto hacía que el backend buscara shift_assignments del día equivocado
 * todas las noches entre 6 PM y 11:59 PM.
 *
 * Estas funciones siempre devuelven la fecha/hora LOCAL de Guatemala,
 * sin importar la zona del servidor.
 */

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Guatemala';

/**
 * Devuelve la fecha local como "YYYY-MM-DD".
 * Equivale a lo que PostgreSQL daría con:
 *   SELECT CURRENT_DATE AT TIME ZONE 'America/Guatemala'
 */
function getTodayDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: APP_TIMEZONE });
}

/**
 * Devuelve la hora local como "HH:MM:SS".
 */
function getLocalTime() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: APP_TIMEZONE, hour12: false });
}

module.exports = { getTodayDate, getLocalTime, APP_TIMEZONE };
