# DEPLOY — bot_IA_rrhh

Guía para desplegar **el bot backend** a los servers Talinda y Hetzner.

> El admin app (FastAPI + Flutter) está en un repo **separado**:
> [`gestion-rrhh`](https://github.com/lpmc59/gestion-rrhh). Tiene su propio
> DEPLOY allí. Ambos repos comparten la DB PostgreSQL.

## Arquitectura de despliegue

| Server | Bot backend (este repo) | Admin app (gestion-rrhh) | DB |
|---|---|---|---|
| Talinda (46.224.52.35) | `/home/admin/projects/bot_IA_rrhh` | `/home/admin/projects/gestion_rrhh_git` | Local |
| Hetzner | `/home/admin/projects/bot_IA_rrhh` | `/home/admin/projects/gestion_rrhh_git` | Local |

## Flujo de trabajo diario

```
[Mac: editar + probar]
    ↓
git add ... && git commit -m "..."
git push
    ↓
[Server Talinda]                [Server Hetzner]
git pull                        git pull
npm install (si package.json)   npm install (si package.json)
aplicar migraciones (si hay)    aplicar migraciones (si hay)
systemctl restart backend       systemctl restart backend
journalctl -f                   journalctl -f
```

## Setup inicial de un server nuevo

Ejemplo con nombres de Hetzner (ajustar paths si son distintos).

### 1. Requisitos base

```bash
# Ubuntu 22.04+
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential postgresql python3 python3-pip python3-venv

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # v22.x

# OpenClaw CLI (como user admin, no root)
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
npm install -g openclaw@latest
openclaw --version
```

### 2. Clonar repo

```bash
cd ~/projects   # o donde tengas tus proyectos
git clone git@github.com:<tu-user>/bot_IA_rrhh.git
cd bot_IA_rrhh
```

### 3. Base de datos

```bash
# Crear DB y user
sudo -u postgres psql <<'SQL'
CREATE DATABASE talindadb;
CREATE USER talindadb_app WITH PASSWORD 'CHANGE_ME';
GRANT ALL PRIVILEGES ON DATABASE talindadb TO talindadb_app;
\c talindadb
CREATE SCHEMA app AUTHORIZATION talindadb_app;
SQL

# Aplicar todas las migraciones en orden
cd backend/migrations
for f in $(ls -1 | sort); do
  echo "Aplicando $f..."
  psql -U talindadb_app -d talindadb -h localhost -f "$f"
done
```

### 4. `.env` del backend

```bash
cp backend/.env.example backend/.env
nano backend/.env
```

**Valores mínimos** (ver `CLAUDE.md` sección "Variables de entorno críticas"):
- DB_* correctos
- `PORT=3000`
- `ANTHROPIC_API_KEY=sk-ant-...`
- `OPENCLAW_GATEWAY_URL=http://127.0.0.1:4000`  ← **verificar `:4000`, no `:40000`**
- `OPENCLAW_GATEWAY_TOKEN=<token>`  ← del `openclaw.json` que vamos a crear
- `MESSAGING_CHANNEL=telegram`

### 5. Instalar deps del backend

```bash
cd ~/projects/bot_IA_rrhh/backend
npm install --production
```

### 6. Onboard de OpenClaw + pairing con Telegram

**Paso crítico**: sin esto, el bot recibe mensajes pero responde "access not configured".

```bash
# Como user admin (NO sudo)
openclaw onboard
```

Respuestas al wizard:
- Proveedor: `anthropic`
- Mode: `api_key`
- API key: la misma del `.env` del backend
- Bot token de Telegram cuando pregunte
- Cuando pida pairing de operator → seguir el link/comando desde Telegram

Editar `~/.openclaw/openclaw.json` para asegurar:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "<TU_BOT_TOKEN>",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  },
  "gateway": {
    "port": 4000,
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "<COPIAR_A_OPENCLAW_GATEWAY_TOKEN_DEL_.ENV>"
    }
  }
}
```

Copiar `SOUL.md` al workspace de OpenClaw:

```bash
cp ~/projects/bot_IA_rrhh/Telegram_Optel/SOUL.md ~/.openclaw/SOUL.md
# O el SOUL.md del bot específico que uses (Talinda vs Optel)
```

### 7. Levantar OpenClaw como service de user-systemd

```bash
# Si hiciste "openclaw onboard --install-daemon" ya debería estar instalado.
# Verificar:
systemctl --user status openclaw-gateway.service

# Si no existe, instalarlo:
openclaw daemon install --port 4000

# Arrancar + habilitar
systemctl --user enable --now openclaw-gateway.service

# Habilitar lingering para que sobreviva al logout del user admin
sudo loginctl enable-linger admin
```

### 8. Levantar backend Node como systemd service

Crear `/etc/systemd/system/bot-ia-rrhh-backend.service`:

```ini
[Unit]
Description=Bot IA RRHH Backend
After=network.target postgresql.service

[Service]
Type=simple
User=admin
WorkingDirectory=/home/admin/projects/bot_IA_rrhh/backend
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PATH=/usr/bin:/home/admin/.npm-global/bin

[Install]
WantedBy=multi-user.target
```

> **IMPORTANTE**: `Environment=PATH=...` debe incluir `/home/admin/.npm-global/bin` para que `execFile('openclaw', ...)` funcione desde el outbox.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bot-ia-rrhh-backend.service
```

### 9. Verificación end-to-end

```bash
# Backend vive
curl http://127.0.0.1:3000/webhook/health
# → {"ok":true,"service":"talinda-openclaw-backend",...}

# OpenClaw vive
curl http://127.0.0.1:4000/health
# → {"ok":true,"status":"live"}

# Test manual del webhook (simula OpenClaw)
curl -X POST http://127.0.0.1:3000/webhook/openclaw \
  -H 'Content-Type: application/json' \
  -d '{"type":"message","channel":"telegram","from":"5825850746","telegramUserId":"5825850746","text":"hola"}'
# → {"reply":"Buenos dias..."}

# Mandar un mensaje real desde Telegram al bot y mirar logs
sudo journalctl -u bot-ia-rrhh-backend.service -f &
journalctl --user -u openclaw-gateway.service -f
```

Esperado en logs del backend al mandar desde Telegram:
```
[INFO] POST /webhook/openclaw
[INFO] Webhook received {"telegramId":"...", ...}
[INFO] NLP: Local match {"intent":"GREETING","confidence":0.95}
[INFO] Fast path: sync reply {"target":"..."}
```

Y en Telegram recibís la respuesta del bot.

### 10. Registrar empleados de prueba

```sql
-- En psql -U talindadb_app -d talindadb
INSERT INTO app.employees (full_name, phone_e164, telegram_id, role, is_active)
VALUES ('Test Empleado', '+50255555555', '5825850746', 'employee', true);
```

(Reemplazar telegram_id con el tuyo. Se obtiene enviando `/start` al bot
[@userinfobot](https://t.me/userinfobot) y leyendo el ID.)

---

## Deploy de cambios (día a día)

### Desde el Mac

```bash
cd /Users/lpmc/Projects/bot_IA_rrhh

# 1. Commitear
git status
git add <archivos>
git commit -m "feat: descripción"

# 2. Push
git push

# 3. Avisar a los servers (script helper opcional abajo)
./deploy-all.sh
```

### En cada server

```bash
cd ~/projects/bot_IA_rrhh
git pull

# Si cambió package.json:
cd backend && npm install --production && cd ..

# Si hay migraciones nuevas (ver `git log --stat` para detectar):
for f in backend/migrations/0NN_nueva_migracion.sql; do
  psql -U talindadb_app -d talindadb -h localhost -f "$f"
done

# Restart bot
sudo systemctl restart bot-ia-rrhh-backend.service

# Verificar que arrancó OK
sudo journalctl -u bot-ia-rrhh-backend.service -n 30 --no-pager
curl http://127.0.0.1:3000/webhook/health

# ── SOUL.md → sincronizar a las 3 ubicaciones de OpenClaw ─────────────
# OpenClaw lee el SOUL.md desde ~/.openclaw/SOUL.md y
# ~/.openclaw/workspace/SOUL.md, NO desde el repo. Si alguno está desactualizado,
# el agente sigue con el prompt viejo y narra/se desvía aunque el repo
# tenga la última versión. Ver gotcha #13 en CLAUDE.md.
#
# El script deploy-soul.sh:
#   - Compara md5 de las 3 ubicaciones
#   - Si difieren, copia con backup automático
#   - Reinicia openclaw-gateway para recargar el prompt
bash backend/openclaw/deploy-soul.sh

# (Soporta --dry-run para ver qué cambiaría sin tocar nada,
#  y --no-restart si querés controlar el restart manual.)
```

### Verificación rápida del SOUL.md (sin script)

```bash
md5sum ~/projects/bot_IA_rrhh/backend/openclaw/SOUL.md \
       ~/.openclaw/SOUL.md \
       ~/.openclaw/workspace/SOUL.md
# Esperado: los 3 hashes IGUALES.
```

### Script `deploy-all.sh` (opcional, ubicar en raíz del repo)

```bash
#!/bin/bash
set -e
SERVERS=(
  "admin@talinda.example.com:/home/admin/projects/bot_IA_rrhh"
  "admin@hetzner.example.com:/home/admin/projects/bot_IA_rrhh"
)

for s in "${SERVERS[@]}"; do
  HOST="${s%:*}"
  DIR="${s#*:}"
  echo "═══ Deploying to $HOST ═══"
  ssh "$HOST" "cd $DIR && git pull && \
    cd backend && npm install --production && \
    sudo systemctl restart bot-ia-rrhh-backend.service && \
    sleep 3 && curl -s http://127.0.0.1:3000/webhook/health && echo"
done
```

## Migraciones

Naming convention: `backend/migrations/NNN_descripcion.sql` (zero-padded).

### Aplicar una migración concreta

```bash
psql -U talindadb_app -d talindadb -h localhost -f backend/migrations/016_waiting_switch_confirm_state.sql
```

### Ver qué migraciones están aplicadas

No hay tabla de tracking automático (no usamos alembic/flyway). El user
lleva el control manualmente o mirando `pg_enum` / `pg_tables` / etc.

Para migración de enum específicamente:
```sql
SELECT enum_range(NULL::app.session_state);
SELECT enum_range(NULL::app.nlp_intent);
```

### Pendientes de aplicar en cada server

| Migración | Talinda | Hetzner |
|---|---|---|
| `016_waiting_switch_confirm_state.sql` | verificar con `SELECT enum_range(NULL::app.session_state);` | verificar |
| `020_continued_status_and_mobile_ui.sql` | aplicar antes de deploy (continúa multi-día + flag `requires_mobile_ui`) | aplicar antes de deploy (necesario para tickets externos optel-redes con UI móvil) |

### Migración 020 — verificación post-aplicación

```sql
-- Debe incluir 'continued'
SELECT unnest(enum_range(NULL::app.task_instance_status));
-- Debe incluir 'CONTINUED_TOMORROW'
SELECT unnest(enum_range(NULL::app.task_update_type));
-- Debe existir la columna
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema='app' AND table_name='tasks' AND column_name='requires_mobile_ui';
```

Y agregar al `.env` del bot:
```
TOKEN_EXPIRY_HOURS_EXTERNAL=168    # 7 días, para tokens de tickets con requires_mobile_ui
```

## Admin app — otro repo

El admin (FastAPI + Flutter) vive en
[`lpmc59/gestion-rrhh`](https://github.com/lpmc59/gestion-rrhh). Se deploya
independiente a `/home/admin/projects/gestion_rrhh_git/`. Tiene su propio
`DEPLOY` allí y un `Dockerfile` para builds reproducibles.

Ambos repos apuntan a la misma DB `talindadb` (schema `app`) — por eso las
migraciones viven acá, en `backend/migrations/`, y el admin las consume
sin aplicarlas.

## Troubleshooting rápido

| Síntoma | Primera hipótesis |
|---|---|
| Telegram no responde | Revisar `.env` → `OPENCLAW_GATEWAY_URL=http://127.0.0.1:4000` (sin ceros extra) |
| "Access not configured" en Telegram | Correr `openclaw onboard` en el server |
| Backend arranca, no procesa mensajes | Verificar `OPENCLAW_GATEWAY_TOKEN` coincide entre `.env` y `openclaw.json` |
| Respuestas async no llegan pero sync sí | `PATH` del systemd service no incluye `/home/admin/.npm-global/bin` |
| Error de enum al cambiar session_state | Falta aplicar migración 016 |
| Alerta `NO_TASK_1H` post-fin de turno | Verificar que backend tenga el fix de shift_end (chequear `ALERT_SHIFT_END_GRACE_MINUTES` en logs del startup) |
| Falta `last_update_at` al recuperar tareas | Columna existe, verificar que `taskService` la updatea en las funciones de estado |

## Secrets y backups

- **NUNCA** commitear `.env` (ya está en `.gitignore`).
- `.env.example` sí va en git (template sin valores).
- Backup de DB: `pg_dump -U talindadb_app -d talindadb > backup-$(date +%Y%m%d).sql`

## Monitoreo post-deploy

Ver `backend/docs/monitoring.md` — 7 señales con SQL listas para copy/paste.
Programar revisión a las 2 semanas después de cambios grandes.
