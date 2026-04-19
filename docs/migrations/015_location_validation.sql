-- Migration 015: Location validation for check-in / check-out
-- Adds:
--   1. app.work_locations              — catalogo central de ubicaciones autorizadas
--   2. app.employees.work_location_id  — referencia opcional por empleado
--   3. app.employees.require_location_check — bandera por empleado
--   4. Columnas en app.checkins para guardar evidencia y status de validacion
-- Resolucion de ubicacion (en orden):
--   a) employee.work_location_id (si no es NULL) → app.work_locations
--   b) Variables .env: LOCATION_DEFAULT_LAT / LNG / RADIUS_M
-- Si LOCATION_CHECK_ENABLED=false en .env → todo el feature queda apagado.

BEGIN;

-- ─── 1. Catalogo de ubicaciones autorizadas ──────────────────────────────
CREATE TABLE IF NOT EXISTS app.work_locations (
    location_id   uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    name          text NOT NULL,
    description   text,
    latitude      double precision NOT NULL,
    longitude     double precision NOT NULL,
    radius_m      integer NOT NULL DEFAULT 150
                    CHECK (radius_m > 0 AND radius_m <= 10000),
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.work_locations IS
  'Catalogo de ubicaciones fisicas autorizadas para check-in/check-out';
COMMENT ON COLUMN app.work_locations.radius_m IS
  'Radio en metros desde (latitude, longitude) considerado dentro de la ubicacion';

CREATE INDEX IF NOT EXISTS idx_work_locations_active
  ON app.work_locations (is_active) WHERE is_active = true;

-- ─── 2. Configuracion por empleado ───────────────────────────────────────
ALTER TABLE app.employees
  ADD COLUMN IF NOT EXISTS require_location_check boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_location_id       uuid REFERENCES app.work_locations(location_id);

COMMENT ON COLUMN app.employees.require_location_check IS
  'Si true, el empleado debe compartir ubicacion al hacer check-in/check-out';
COMMENT ON COLUMN app.employees.work_location_id IS
  'Ubicacion autorizada para este empleado. Si NULL, se usan los defaults del .env';

CREATE INDEX IF NOT EXISTS idx_employees_work_location
  ON app.employees (work_location_id) WHERE work_location_id IS NOT NULL;

-- ─── 3. Registro de validacion en checkins ───────────────────────────────
ALTER TABLE app.checkins
  ADD COLUMN IF NOT EXISTS location_required   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS location_shared     boolean,
  ADD COLUMN IF NOT EXISTS location_lat        double precision,
  ADD COLUMN IF NOT EXISTS location_lng        double precision,
  ADD COLUMN IF NOT EXISTS location_accuracy_m integer,
  ADD COLUMN IF NOT EXISTS distance_m          integer,
  ADD COLUMN IF NOT EXISTS location_valid      boolean,
  ADD COLUMN IF NOT EXISTS location_status     text
    CHECK (location_status IN (
      'not_required',   -- el feature esta apagado o el empleado no requiere validacion
      'valid',          -- compartio ubicacion y esta dentro del radio
      'out_of_range',   -- compartio ubicacion pero esta fuera del radio
      'not_shared',     -- se le pidio y no quiso compartir (o respondio con texto)
      'low_accuracy'    -- compartio pero la precision GPS es peor que el radio
    )),
  ADD COLUMN IF NOT EXISTS location_resolved_from text
    CHECK (location_resolved_from IN ('employee', 'env_default', NULL));

COMMENT ON COLUMN app.checkins.location_required IS
  'Snapshot: si en el momento del check-in se le requeria compartir ubicacion';
COMMENT ON COLUMN app.checkins.location_shared IS
  'true si compartio, false si no quiso, NULL si no se le pidio';
COMMENT ON COLUMN app.checkins.distance_m IS
  'Distancia en metros desde la ubicacion autorizada (Haversine)';
COMMENT ON COLUMN app.checkins.location_status IS
  'Estado consolidado de la validacion de ubicacion';
COMMENT ON COLUMN app.checkins.location_resolved_from IS
  'De donde se obtuvieron las coordenadas autorizadas: employee (work_location_id) o env_default';

-- Indice para reportes de anomalias
CREATE INDEX IF NOT EXISTS idx_checkins_location_anomaly
  ON app.checkins (work_date, location_status)
  WHERE location_status IN ('out_of_range', 'not_shared', 'low_accuracy');

-- ─── 4. Permisos (ajustar al usuario de la app) ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON app.work_locations TO talindadb_app;

COMMIT;
