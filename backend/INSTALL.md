# Guia Completa de Instalacion - TALINDA OpenClaw Backend

## Requisitos previos

- Ubuntu 20.04 LTS
- PostgreSQL 12.22 con base de datos `talindadb` y schema `app` ya creados
- Acceso sudo al servidor
- Un numero de telefono dedicado para WhatsApp (recomendado)
- API Key de Anthropic (Claude Sonnet 4)

## Arquitectura del sistema

```
WhatsApp (empleado)
     |
     v
OpenClaw Gateway (puerto 4000, daemon systemd)
     |
     v
OpenClaw Skill (talinda-tasks)
     |
     v
Backend API Node.js (puerto 3000)
     |
     +---> NLP Local (patrones regex, keyword_dictionary)
     |         |
     |         +--> Si no matchea: Claude Sonnet 4 (API Anthropic)
     |
     +---> PostgreSQL (talindadb, schema app)
     |
     +---> Outbox Worker -> OpenClaw Gateway -> WhatsApp (respuesta)
     |
     +---> Cron: Auto check-in (cada 5 min)
```

---

## PASO 1: Instalar Node.js 22

```bash
# En tu servidor Ubuntu 20.04
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl git build-essential

# Instalar Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verificar
node --version   # debe ser >= v22.x.x
npm --version
```

## PASO 2: Instalar OpenClaw

```bash
# Instalar OpenClaw globalmente
sudo npm install -g openclaw@latest

# Verificar instalacion
openclaw --version
```

## PASO 3: Configurar OpenClaw (primera vez)

```bash
# Ejecutar wizard de onboarding
# Esto instalara el daemon (servicio systemd) automaticamente
openclaw onboard --install-daemon
```

Durante el onboarding:
1. Selecciona **Anthropic** como proveedor de LLM
2. Ingresa tu `ANTHROPIC_API_KEY`
3. Selecciona **claude-haiku-4-5** como modelo (o claude-sonnet-4-6 para OpenClaw general)
4. Acepta instalar el daemon

El Gateway quedara como servicio systemd y sobrevive reinicios.

## PASO 4: Conectar WhatsApp

```bash
# Iniciar login de WhatsApp
openclaw channels login --channel whatsapp
```

1. Se mostrara un **QR code** en la terminal
2. Abre WhatsApp en tu telefono dedicado
3. Ve a **Dispositivos vinculados** > **Vincular un dispositivo**
4. Escanea el QR code
5. Espera a que se confirme la conexion

La sesion se guarda en `~/.openclaw/credentials/whatsapp-creds.json`.

**IMPORTANTE**: Usa un numero de telefono dedicado, no tu numero personal.

## PASO 5: Copiar y configurar el Backend

```bash
# Crear directorio del proyecto
sudo mkdir -p /home/talinda_openclaw/backend
sudo mkdir -p /home/talinda_openclaw/uploads
sudo mkdir -p /home/talinda_openclaw/logs

# Copiar los archivos del backend (desde donde los tengas)
# Opcion A: Desde tu maquina local via SCP
# scp -r ./backend/* usuario@192.168.50.39:/home/talinda_openclaw/backend/

# Opcion B: Si ya estan en el servidor
cp -r /ruta/al/backend/* /home/talinda_openclaw/backend/

# Ir al directorio
cd /home/talinda_openclaw/backend

# Instalar dependencias
npm install --production
```

## PASO 6: Configurar variables de entorno

```bash
# Editar el archivo .env
nano /home/talinda_openclaw/backend/.env
```

Contenido del `.env`:

```env
# Base de Datos (ya configurada en tu servidor)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=talindadb
DB_USER=talindadb_app
DB_PASSWORD=TalindA2020
DB_SCHEMA=app

# Servidor
PORT=3000
NODE_ENV=production

# Anthropic - CAMBIAR POR TU API KEY REAL
ANTHROPIC_API_KEY=sk-ant-TU-API-KEY-AQUI

# OpenClaw Gateway
OPENCLAW_GATEWAY_URL=http://localhost:4000
OPENCLAW_GATEWAY_TOKEN=tu-token-del-dashboard

# Archivos
UPLOAD_DIR=/home/talinda_openclaw/uploads
MAX_FILE_SIZE_MB=10

# Auto check-in: minutos despues del inicio de turno para reportar automaticamente
AUTO_CHECKIN_DELAY_MINUTES=10
```

**Para obtener el OPENCLAW_GATEWAY_TOKEN:**
1. Abre el dashboard de OpenClaw: `http://tu-servidor:4000`
2. El token se muestra durante el onboarding
3. Tambien lo encuentras en `~/.openclaw/config.json`

## PASO 7: Registrar el Skill de OpenClaw

El skill es lo que conecta OpenClaw con tu backend. Copia el archivo:

```bash
# Crear directorio de skills
mkdir -p ~/.openclaw/skills/talinda-tasks

# Copiar el skill
cp /home/talinda_openclaw/backend/openclaw/openclaw-skill.js \
   ~/.openclaw/skills/talinda-tasks/index.js

# Crear package.json minimo para el skill
cat > ~/.openclaw/skills/talinda-tasks/package.json << 'EOF'
{
  "name": "talinda-tasks",
  "version": "1.0.0",
  "main": "index.js"
}
EOF
```

Luego registra el skill en la configuracion de OpenClaw:

```bash
# Editar config de OpenClaw
nano ~/.openclaw/config.json
```

Agrega la seccion de skills (o hooks):

```json
{
  "skills": {
    "talinda-tasks": {
      "enabled": true,
      "path": "~/.openclaw/skills/talinda-tasks",
      "env": {
        "TALINDA_BACKEND_URL": "http://localhost:3000"
      }
    }
  }
}
```

**Alternativa: Usar webhooks en vez de skills:**

Si OpenClaw soporta webhooks HTTP directos:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "talinda-webhook": {
          "enabled": true,
          "url": "http://localhost:3000/webhook/openclaw",
          "events": ["message", "media"]
        }
      }
    }
  }
}
```

## PASO 8: Crear servicio systemd para el Backend

```bash
sudo tee /etc/systemd/system/talinda-backend.service > /dev/null << 'EOF'
[Unit]
Description=TALINDA OpenClaw Backend
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/home/talinda_openclaw/backend
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Recargar systemd, habilitar e iniciar
sudo systemctl daemon-reload
sudo systemctl enable talinda-backend
sudo systemctl start talinda-backend
```

## PASO 9: Verificar que todo funciona

```bash
# 1. Verificar el backend
curl http://localhost:3000/webhook/health
# Respuesta esperada: {"ok":true,"service":"talinda-openclaw-backend",...}

# 2. Verificar conexion a la base de datos
curl http://localhost:3000/api/employees
# Respuesta: lista de empleados

# 3. Ver logs del backend
sudo journalctl -u talinda-backend -f

# 4. Verificar OpenClaw Gateway
sudo systemctl status openclaw
# o:
openclaw status

# 5. Ver dashboard de OpenClaw
# Abrir en navegador: http://192.168.50.39:4000
```

## PASO 10: Probar el flujo completo

1. Envia un mensaje de WhatsApp al numero conectado: **"Hola"**
2. Deberias recibir una respuesta con saludo y turno
3. Envia: **"Me reporto"**
4. Recibiras tus tareas del dia
5. Envia: **"50%"** para reportar avance
6. Envia: **"Ya termine"** para completar una tarea

---

## Estructura de archivos del Backend

```
backend/
├── .env                          # Variables de entorno
├── .env.example                  # Ejemplo de .env
├── package.json                  # Dependencias Node.js
├── INSTALL.md                    # Esta guia
├── src/
│   ├── index.js                  # Punto de entrada del servidor
│   ├── config/
│   │   └── database.js           # Pool de conexiones PostgreSQL
│   ├── routes/
│   │   ├── webhook.js            # POST /webhook/openclaw (entrada de mensajes)
│   │   └── api.js                # GET /api/* (consultas REST)
│   ├── services/
│   │   ├── employeeService.js    # Busqueda de empleados
│   │   ├── shiftService.js       # Gestion de turnos
│   │   ├── taskService.js        # CRUD de tareas e instancias
│   │   ├── messageService.js     # Pipeline principal de procesamiento
│   │   ├── nlpService.js         # NLP local + Claude Sonnet 4
│   │   ├── checkinService.js     # Registro de check-ins
│   │   ├── outboxService.js      # Cola de mensajes salientes
│   │   └── attachmentService.js  # Manejo de fotos/archivos
│   ├── cron/
│   │   ├── autoCheckin.js        # Auto-reporte a los 10 min
│   │   └── outboxWorker.js       # Envio de mensajes en cola
│   └── utils/
│       └── logger.js             # Logging con Winston
└── openclaw/
    ├── install.sh                # Script de instalacion completa
    └── openclaw-skill.js         # Skill de OpenClaw
```

## API REST disponible

| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| POST | /webhook/openclaw | Recibe mensajes de OpenClaw |
| POST | /webhook/upload | Sube archivos adjuntos |
| GET | /webhook/health | Health check |
| GET | /api/employees | Lista de empleados activos |
| GET | /api/employees/:id | Detalle de empleado |
| GET | /api/employees/:id/tasks | Tareas del empleado (por fecha) |
| GET | /api/employees/:id/messages | Historial de chat |
| GET | /api/tasks/today | Todas las tareas del dia |
| GET | /api/shifts/today | Asignaciones de turnos del dia |
| GET | /api/dashboard | Estadisticas del dia |
| GET | /api/nlp/stats | Estadisticas de uso de NLP/Claude |
| GET | /api/outbox | Estado de mensajes en cola |

## Flujo de procesamiento de mensajes

```
1. Empleado envia mensaje por WhatsApp
2. OpenClaw Gateway recibe el mensaje
3. Skill/Hook reenvía a POST /webhook/openclaw
4. Backend identifica al empleado (por telefono o openclaw_user_id)
5. Guarda mensaje en chat_messages (direction='in')
6. Obtiene/crea sesion de chat (chat_sessions)
7. Si la sesion tiene estado pendiente → maneja respuesta multi-turno
8. NLP analiza el mensaje:
   a. Patrones locales (regex) → sin costo
   b. keyword_dictionary de la BD → sin costo
   c. Claude Sonnet 4 → solo si es necesario
9. Segun la intencion detectada:
   - GREETING → saludo + info de turno
   - CHECK_IN → registra llegada + muestra tareas
   - TASK_LIST_REQUEST → lista tareas del dia
   - TASK_DONE → marca tarea completada
   - TASK_PROGRESS → actualiza porcentaje
   - TASK_BLOCKED → marca bloqueo + notifica supervisor
   - TASK_CREATE → crea nueva tarea ad-hoc
   - VAGUE_MESSAGE → pide mas detalles
10. Guarda extraccion NLP en nlp_message_extractions
11. Guarda respuesta en chat_messages (direction='out')
12. Retorna respuesta a OpenClaw → WhatsApp
```

## Comandos utiles

```bash
# Ver estado del backend
sudo systemctl status talinda-backend

# Reiniciar backend
sudo systemctl restart talinda-backend

# Ver logs en tiempo real
sudo journalctl -u talinda-backend -f

# Ver logs de error
sudo journalctl -u talinda-backend --since "1 hour ago" -p err

# Ver estado de OpenClaw
openclaw status
sudo systemctl status openclaw

# Reiniciar OpenClaw
sudo systemctl restart openclaw

# Ver dashboard de tareas del dia
curl -s http://localhost:3000/api/dashboard | python3 -m json.tool

# Ver estadisticas de uso de Claude (costos)
curl -s http://localhost:3000/api/nlp/stats | python3 -m json.tool
```

## Troubleshooting

### El backend no inicia
```bash
# Verificar logs
sudo journalctl -u talinda-backend -n 50

# Verificar conexion a PostgreSQL
psql -h localhost -U talindadb_app -d talindadb -c "SELECT 1"

# Verificar que el puerto 3000 no esta en uso
sudo lsof -i :3000
```

### OpenClaw no conecta con WhatsApp
```bash
# Re-vincular WhatsApp
openclaw channels login --channel whatsapp

# Verificar credenciales
ls -la ~/.openclaw/credentials/
```

### Los mensajes no llegan al backend
```bash
# Verificar que el skill esta registrado
cat ~/.openclaw/config.json

# Probar el webhook directamente
curl -X POST http://localhost:3000/webhook/openclaw \
  -H "Content-Type: application/json" \
  -d '{"type":"message","from":"+502XXXXXXXX","text":"hola"}'
```

### Claude no responde / error de API
```bash
# Verificar API key
grep ANTHROPIC_API_KEY /home/talinda_openclaw/backend/.env

# Probar API key
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: TU_KEY" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5","max_tokens":10,"messages":[{"role":"user","content":"test"}]}'
```
