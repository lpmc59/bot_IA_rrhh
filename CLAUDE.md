# bot_IA_rrhh — Contexto del proyecto para Claude

> Leé este archivo antes de operar en el repo. Resume qué es, cómo está
> estructurado y los gotchas aprendidos.

## Qué es

Este repo es el **backend del bot de Telegram** (junto con las configs de
OpenClaw). Un operador envía mensajes al bot — el bot los procesa, los
vincula a tareas, registra tiempos, y alerta al supervisor cuando detecta
problemas.

Despliegue actual: 2 servers SSH en Linux (Talinda y Hetzner). Se sincroniza
vía git (GitHub). El Mac es solo desarrollo.

### Arquitectura de 2 repos separados

El sistema tiene dos componentes, cada uno en su propio repo:

| Repo | Carpeta local | GitHub | Rol |
|---|---|---|---|
| **bot_IA_rrhh** (este repo) | `/Users/lpmc/Projects/bot_IA_rrhh` | `lpmc59/bot_IA_rrhh` | Bot Telegram (Node.js) + configs OpenClaw |
| **gestion-rrhh** | `/Users/lpmc/Projects/gestion_rrhh_git` | `lpmc59/gestion-rrhh` | Admin app (FastAPI + Flutter) con KPIs y reportes |

**Comparten la misma base de datos PostgreSQL** (`talindadb`, schema `app`),
pero son deployables y evolucionables independientemente.

## Arquitectura de runtime

```
Usuario Telegram
    ↓  (bot token de Telegram en openclaw.json)
OpenClaw  (agente LLM + gateway HTTP en loopback:4000)
    ↓  fetch POST a http://localhost:3000/webhook/openclaw
Backend Node.js/Express  (servicio "bot-ia-rrhh-backend")
    ├─ sync path: devuelve {reply:"..."} inline → OpenClaw responde al usuario
    └─ async path: devuelve {ok:true}, luego llama CLI `openclaw message send`
PostgreSQL "talindadb" (schema "app")
    ↑
Admin FastAPI (talinda_admin_cs/backend, puerto ~8000)
    ↑  HTTP
Admin Flutter (talinda_admin_cs/frontend, web + desktop)
```

Componentes separados, repo único.

## Estructura del repo

```
bot_IA_rrhh/
├── backend/                       ← Node.js (bot + webhook + crons)
│   ├── src/
│   │   ├── cron/                  ← autoCheckin, autoCheckout, outboxWorker,
│   │   │                            supervisorAlerts (4 alertas activas)
│   │   ├── routes/                ← webhook.js, api.js, mobile.js
│   │   ├── services/              ← messageService, taskService, nlpService,
│   │   │                            outboxService, attachmentService,
│   │   │                            transcriptionService, employeeService
│   │   ├── config/database.js
│   │   └── utils/
│   ├── migrations/                ← SQL numeradas 001..NNN
│   ├── openclaw/                  ← install.sh + skill legacy (no se usa)
│   ├── docs/                      ← monitoring.md (señales 1-7)
│   └── .env.example
├── Telegram_Optel/                ← config OpenClaw para bot @OptelBot
│   ├── openclaw.json              ← gateway + token telegram
│   └── SOUL.md                    ← system prompt del agente
├── Telegram_Talinda/              ← config OpenClaw para bot Talinda
└── CLAUDE.md, DEPLOY.md, README.md
```

**Nota**: El admin app (Python FastAPI + Flutter) vive en el repo
[`gestion-rrhh`](https://github.com/lpmc59/gestion-rrhh), NO acá.

## Stack

| Componente | Tecnología |
|---|---|
| Bot backend | Node.js 22, Express, pg, node-cron, multer |
| NLP | Regex local + Claude Haiku 4.5 como fallback (`@anthropic-ai/sdk`) |
| Admin backend | Python 3.8+ FastAPI, psycopg2 |
| Admin frontend | Flutter 3.x (target: web principalmente, también desktop) |
| DB | PostgreSQL — DB `talindadb`, schema `app` |
| Gateway Telegram | OpenClaw (`openclaw-gateway.service`, user-systemd) |

## Paths por server

### Mac (desarrollo)
- `bot_IA_rrhh`: `/Users/lpmc/Projects/bot_IA_rrhh`
- `gestion-rrhh`: `/Users/lpmc/Projects/gestion_rrhh_git`

### Talinda SSH (46.224.52.35) — prod 1
- `bot_IA_rrhh`: `/home/admin/projects/bot_IA_rrhh`
- `gestion-rrhh`: `/home/admin/projects/gestion_rrhh_git`

### Hetzner SSH — prod 2
- `bot_IA_rrhh`: `/home/admin/projects/bot_IA_rrhh`
- `gestion-rrhh`: `/home/admin/projects/gestion_rrhh_git`
- Backend service (este repo): `bot-ia-rrhh-backend.service` (systemd, user=admin)
  - ExecStart: `/usr/bin/node src/index.js`
  - WorkingDirectory: `/home/admin/projects/bot_IA_rrhh/backend/`
  - Port: 3000
- OpenClaw service: `openclaw-gateway.service` (systemd **--user**, user=admin)
  - Comandos con `systemctl --user ...`
  - Path: `/home/admin/.npm-global/lib/node_modules/openclaw/dist/index.js gateway --port 4000`
  - Workspace: `/home/admin/.openclaw/`
  - Config: `/home/admin/.openclaw/openclaw.json`
  - SOUL.md: `/home/admin/.openclaw/SOUL.md` y `/home/admin/.openclaw/workspace/SOUL.md`
- DB local compartida entre ambos repos (ver `.env`)

## Variables de entorno críticas (`backend/.env`)

```bash
# DB
DB_HOST=localhost
DB_PORT=5432
DB_NAME=talindadb
DB_USER=talindadb_app
DB_PASSWORD=***
DB_SCHEMA=app

# Server
PORT=3000
NODE_ENV=production

# Anthropic (para Claude Haiku 4.5 como NLP fallback)
ANTHROPIC_API_KEY=sk-ant-***

# OpenClaw — EL PUERTO es 4000, NO 40000. Un typo aquí rompe outbox silenciosamente.
OPENCLAW_GATEWAY_URL=http://127.0.0.1:4000
OPENCLAW_GATEWAY_TOKEN=***  # copiar de openclaw.json → gateway.auth.token

# Canal
MESSAGING_CHANNEL=telegram   # telegram | whatsapp

# Uploads
UPLOAD_DIR=./uploads
MAX_FILE_SIZE_MB=10

# Crons
AUTO_CHECKIN_DELAY_MINUTES=15
AUTO_CHECKOUT_GRACE_MINUTES=10
AUTO_CHECKOUT_CLOSE_MINUTES=20

# Supervisor alerts
ALERT_NO_CHECKIN_MINUTES=60          # default en Hetzner: 30
ALERT_NO_TASK_MINUTES=60
ALERT_SHIFT_END_GRACE_MINUTES=0      # NO_TASK_1H deja de disparar post-turno
ALERT_OPEN_TASKS_END_GRACE_MINUTES=15 # min tras fin de turno antes de alertar tareas abiertas
ALERT_OVERTIME_FACTOR=2
```

## Supervisor alerts (cron cada 15 min en `backend/src/cron/supervisorAlerts.js`)

| Reason code | Dispara cuando… |
|---|---|
| `NO_CHECKIN_1H` | Turno empezó hace >N min y el empleado no hizo check-in |
| `NO_TASK_1H` | Empleado con check-in, sin actividad de tarea en N min, **turno activo** (respeta end_time + `SHIFT_END_GRACE_MINUTES`) |
| `TASK_OVERTIME` | Tarea `in_progress` con elapsed > `factor × standard_minutes` |
| `OPEN_TASKS_SHIFT_END` | Turno terminó hace >N min con tareas `in_progress`/`blocked` sin cerrar |

Dedup: 1 alerta por reason por `employee_id` por `work_date`.
Turnos nocturnos soportados (end_time ≤ start_time → end_time es al día siguiente).

## Fixes de flujo conversacional (1-5) aplicados

1. Regex `terminar` cubre infinitivo y conjugaciones (nlpService + messageService).
2. `handleTaskStart` con tarea en progreso pide confirmación: pausar / terminar N / simultáneo / cancelar. Nuevo estado `WAITING_SWITCH_CONFIRM`.
3. `handleTaskDone` con >1 tarea in_progress pide al empleado que aclare cuál.
4. `WAITING_TASK_PICK` re-muestra lista si llega un "termine" ambiguo.
5. Claude Haiku 4.5 como second-opinion cuando el contexto es ambiguo (>1 tarea in_progress, sin referencia explícita).

Intent `TASK_SWITCH` (compuesto) está **diferido**. Medir antes (ver
`backend/docs/monitoring.md` señales 1-6).

## Migraciones importantes

- `migrations/016_waiting_switch_confirm_state.sql` — añade al enum
  `app.session_state`: `WAITING_SWITCH_CONFIRM`, `WAITING_LOCATION`,
  `WAITING_NEXT_TASK_CONFIRM`. **Correr antes** de desplegar los fixes 1-5.

Las migraciones son SQL crudo. No hay framework (como alembic, flyway). Se
aplican manualmente con `psql -f`.

## Gotchas descubiertos (aprender de mis errores)

| # | Gotcha | Solución |
|---|---|---|
| 1 | `.env` con `OPENCLAW_GATEWAY_URL=http://127.0.0.1:40000` (zero extra) | El agente hace fetch al backend sync, pero el outbox CLI falla. Telegram "no responde". Fix: `:4000` |
| 2 | Primer deploy de OpenClaw en server nuevo: Telegram dice "access not configured, pairing required" | Correr `openclaw onboard` manualmente en el server (como user admin, no root). Registra el operator. |
| 3 | `openclaw-gateway.service` como systemd user (`--user` flag) | Comandos requieren `systemctl --user`, no sudo. Logs con `journalctl --user -u openclaw-gateway -f`. |
| 4 | CLI `openclaw` instalado en `/home/admin/.npm-global/bin` | Si el backend corre como user distinto, `execFile('openclaw', ...)` falla. Actualmente corre como `admin`, por eso funciona. |
| 5 | `task_instances.planned_minutes` es columna **legacy orfana** | Nunca se popula. Reportes deben usar `standard_minutes` (de `shift_task_templates.standard_minutes` o `task_templates.default_minutes`). `planned_minutes` reservado para asignaciones individuales futuras. |
| 6 | `Alert 2 (NO_TASK_1H)` antes no filtraba por fin de turno | Fijado con JOIN a `shift_assignments` + `shift_templates` y check `NOW() < end_time + grace`. |
| 7 | OpenClaw agente vs gateway | El "gateway" es solo API loopback. Sin agente LLM con SOUL.md, OpenClaw no relaya respuestas del backend. `openclaw onboard` arma ambos. |

## Decisiones de diseño claves

- **Fast path sync**: NLP local (regex) resuelve ~80% de mensajes. Devuelve `{reply:"..."}` inline al webhook. Claude solo interviene en ambigüedad.
- **Deduplication** de mensajes entrantes: misma frase + mismo phone en <60s se ignora (evita retry storms de OpenClaw).
- **Session state machine** en `app.chat_sessions.state` (enum `app.session_state`). Estados: IDLE, WAITING_TASK_PICK, WAITING_BLOCK_REASON, WAITING_SWITCH_CONFIRM, etc.
- **Tareas ad-hoc** desde Telegram van a la misma tabla `task_instances` con `status='in_progress'`. NO hay columna que las distinga estructuralmente.
- **Supervisor form** para rol `supervisor_auditor`: escalación genera un token y link móvil para formulario de seguimiento.

## Comandos frecuentes

```bash
# Verificar sintaxis Node sin correr
node --check src/cron/supervisorAlerts.js

# Applicar migración
psql -U talindadb_app -d talindadb -f backend/migrations/016_waiting_switch_confirm_state.sql

# Reiniciar backend
sudo systemctl restart bot-ia-rrhh-backend.service

# Reiniciar OpenClaw (servidor)
systemctl --user restart openclaw-gateway.service

# Seguir logs en vivo
sudo journalctl -u bot-ia-rrhh-backend.service -f
journalctl --user -u openclaw-gateway.service -f

# Health del backend
curl -s http://localhost:3000/webhook/health

# Health de OpenClaw
curl -s http://127.0.0.1:4000/health

# Test manual del webhook (sin pasar por Telegram)
curl -X POST http://localhost:3000/webhook/openclaw \
  -H 'Content-Type: application/json' \
  -d '{"type":"message","channel":"telegram","from":"5825850746","telegramUserId":"5825850746","text":"hola"}'
```

## El admin Flutter/FastAPI (repo separado)

Vive en [`gestion-rrhh`](https://github.com/lpmc59/gestion-rrhh). Compartimos
solo la base de datos. El admin:

- Consulta `app.task_instances` vía FastAPI para reportes por empleado/día
- Muestra KPIs con tooltips explicando cada fórmula (Min Std, Sobretiempo, Ganados, Neto, Eficiencia, Tasa Completitud, etc.)
- Genera vistas HTML imprimibles
- Tiene su propio Dockerfile para deploy independiente
- Independiente del bot/OpenClaw — solo comparte DB

## Para mí (Claude) en futuras sesiones

- Leer este CLAUDE.md y `DEPLOY.md` antes de tocar nada
- Consultar `backend/docs/monitoring.md` si se pregunta por observabilidad
- Consultar `backend/migrations/` para ver qué schema está aplicado
- Los SOUL.md son **prompts** de OpenClaw, no código propio — no los refactorizar a la ligera
- Cuando el user diga "no me responde el bot", revisar primero el flujo logs backend → logs OpenClaw → Telegram getUpdates. Mi primera hipótesis siempre: tipeo en puerto/token del .env.
