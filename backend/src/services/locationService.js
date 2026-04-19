const { query } = require('../config/database');
const logger = require('../utils/logger');

// ─── Configuracion via .env ─────────────────────────────────────────────────
const LOCATION_CHECK_ENABLED = String(process.env.LOCATION_CHECK_ENABLED || 'false').toLowerCase() === 'true';
const DEFAULT_LAT = parseFloat(process.env.LOCATION_DEFAULT_LAT || '');
const DEFAULT_LNG = parseFloat(process.env.LOCATION_DEFAULT_LNG || '');
const DEFAULT_RADIUS_M = parseInt(process.env.LOCATION_DEFAULT_RADIUS_M || '150');

function isFeatureEnabled() {
  return LOCATION_CHECK_ENABLED;
}

// ─── Distancia Haversine en metros ──────────────────────────────────────────
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // radio terrestre en metros
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ─── Resolver ubicacion autorizada para un empleado ─────────────────────────
// Orden:
//   1. employee.work_location_id → app.work_locations
//   2. .env defaults
// Retorna { lat, lng, radius_m, source: 'employee'|'env_default', name } o null si no hay nada.
async function resolveAuthorizedLocation(employee) {
  if (employee.work_location_id) {
    const res = await query(
      `SELECT location_id, name, latitude, longitude, radius_m
       FROM work_locations
       WHERE location_id = $1 AND is_active = true`,
      [employee.work_location_id]
    );
    if (res.rows[0]) {
      const loc = res.rows[0];
      return {
        lat: loc.latitude,
        lng: loc.longitude,
        radius_m: loc.radius_m,
        source: 'employee',
        name: loc.name,
      };
    }
    logger.warn('Employee has work_location_id but location not found/inactive', {
      employeeId: employee.employee_id, workLocationId: employee.work_location_id,
    });
  }

  if (!isNaN(DEFAULT_LAT) && !isNaN(DEFAULT_LNG)) {
    return {
      lat: DEFAULT_LAT,
      lng: DEFAULT_LNG,
      radius_m: DEFAULT_RADIUS_M,
      source: 'env_default',
      name: 'Ubicacion por defecto',
    };
  }

  return null;
}

// ─── Decidir si se debe pedir ubicacion a un empleado ───────────────────────
function shouldRequireLocation(employee) {
  if (!isFeatureEnabled()) return false;
  return employee.require_location_check === true;
}

// ─── Validar coordenadas reportadas contra la ubicacion autorizada ──────────
// Retorna:
//   {
//     status: 'valid' | 'out_of_range' | 'low_accuracy',
//     valid: boolean,
//     distance_m: integer,
//     authorized: { lat, lng, radius_m, source, name }
//   }
async function validateLocation(employee, lat, lng, accuracyM) {
  const authorized = await resolveAuthorizedLocation(employee);
  if (!authorized) {
    logger.warn('No authorized location resolved for employee', { employeeId: employee.employee_id });
    return null;
  }

  const distance = Math.round(haversineMeters(lat, lng, authorized.lat, authorized.lng));

  // Si la precision GPS es peor que el radio permitido, no podemos confiar
  // en si esta dentro o fuera. Lo marcamos como low_accuracy (registrar pero no bloquear).
  if (accuracyM && accuracyM > authorized.radius_m) {
    return {
      status: 'low_accuracy',
      valid: false,
      distance_m: distance,
      authorized,
    };
  }

  if (distance <= authorized.radius_m) {
    return { status: 'valid', valid: true, distance_m: distance, authorized };
  }
  return { status: 'out_of_range', valid: false, distance_m: distance, authorized };
}

module.exports = {
  isFeatureEnabled,
  shouldRequireLocation,
  resolveAuthorizedLocation,
  validateLocation,
  haversineMeters,
};
