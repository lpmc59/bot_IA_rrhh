En la carpeta TELEGRAM estan los files OK 
openclaw.json.   /home/admin/.openclaw/workspace/SOUL.md
SOULD.md.       /home/admin/.openclaw/openclaw.json

# Reiniciar ambos servicios
sudo systemctl restart openclaw-gateway
sudo systemctl restart talinda-bot-backend.service


# Pasos iniciales por LP
sudo mkdir -p /home/talinda_openclaw

id cafe
ls -ld /home/talinda_openclaw
sudo mkdir -p /home/talinda_openclaw/files

# crear subcarpeta donde el usuario podrá trabajar
sudo mkdir -p /home/talinda_openclaw/files

# asegurar que la raíz del chroot sea root:root (obligatorio para chroot SFTP)
sudo chown root:root /home/talinda_openclaw
sudo chmod 755 /home/talinda_openclaw

# dar ownership y permisos restringidos al subdirectorio editable
sudo chown cafe:$(id -gn cafe) /home/talinda_openclaw/files
sudo chmod 700 /home/talinda_openclaw/files

# verificación
ls -ld /home/talinda_openclaw /home/talinda_openclaw/files
id cafe

#RESULTADO:
cafe@Cafe:/home$ ls -ld /home/talinda_openclaw /home/talinda_openclaw/files
drwxr-xr-x 3 root root 3 Feb 17 08:54 /home/talinda_openclaw
drwx------ 2 cafe cafe 2 Feb 17 08:54 /home/talinda_openclaw/files
cafe@Cafe:/home$ 



#################################################OPENCLAW##########################
# Sistema de Seguimiento de Actividades con OpenClaw

Sistema de gestión de tareas y seguimiento de actividades que utiliza OpenClaw para permitir a los empleados actualizar su trabajo de forma natural mediante conversaciones en lugar de interfaces tradicionales tipo ClickUp.

## 📋 Índice

1. [Descripción del Proyecto](#descripción-del-proyecto)
2. [Arquitectura](#arquitectura)
3. [Requisitos](#requisitos)
4. [Instalación](#instalación)
5. [Estructura de la Base de Datos](#estructura-de-la-base-de-datos)
6. [Uso](#uso)
7. [Próximos Pasos](#próximos-pasos)

## 🎯 Descripción del Proyecto

Este sistema permite a tu equipo actualizar tareas y reportar progreso de forma conversacional a través de OpenClaw, eliminando la fricción de las herramientas tradicionales de gestión de proyectos.

### Ventajas

✅ **Menos fricción**: Los colaboradores escriben naturalmente en chat  
✅ **Contexto conversacional**: Pueden explicar blockers y detalles  
✅ **Menor resistencia**: No sienten la presión de "llenar formularios"  
✅ **Datos más ricos**: Capturas el "por qué" además del "qué"  
✅ **Multi-canal**: WhatsApp, Telegram, Slack, Discord, etc.

## 🏗️ Arquitectura

```
┌─────────────────┐
│   Empleados     │
│  (WhatsApp,     │
│   Telegram,     │
│   Slack, etc)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   OpenClaw      │
│   Gateway       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Backend API    │
│   (Node.js/     │
│    Python)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  PostgreSQL     │
│   Database      │
└─────────────────┘
```

## 📦 Requisitos

### Sistema
- Ubuntu Server 20.04 o superior
- 2GB RAM mínimo (4GB recomendado)
- 10GB espacio en disco
- Acceso root o sudo

### Software
- PostgreSQL 16
- Node.js 22+ (para OpenClaw)
- Git

## 🚀 Instalación

### Paso 1: Instalar PostgreSQL y Base de Datos

Los archivos incluidos en este paquete:

```
📁 proyecto/
├── schema_openclaw_tracking.sql  # Schema completo de BD
├── install_database.sh           # Script de instalación automática
├── queries_utiles.sql            # Queries útiles para administración
└── README.md                     # Este archivo
```

#### Instalación Automática (Recomendado)

```bash
# Dar permisos de ejecución al script
chmod +x install_database.sh

# Ejecutar instalación
sudo ./install_database.sh
```

El script te pedirá:
- Contraseña para el usuario de base de datos
- Si deseas habilitar acceso remoto

#### Instalación Manual

Si prefieres hacerlo manualmente:

```bash
# 1. Instalar PostgreSQL
sudo apt-get update
sudo apt-get install -y postgresql-16 postgresql-contrib-16

# 2. Iniciar PostgreSQL
sudo systemctl start postgresql
sudo systemctl enable postgresql

# 3. Crear base de datos y usuario
sudo -u postgres psql <<EOF
CREATE USER openclaw_admin WITH PASSWORD 'tu_password_seguro';
CREATE DATABASE seguimiento_openclaw OWNER openclaw_admin;
GRANT ALL PRIVILEGES ON DATABASE seguimiento_openclaw TO openclaw_admin;
EOF

# 4. Ejecutar schema
sudo -u postgres psql -d seguimiento_openclaw -f schema_openclaw_tracking.sql
```

### Paso 2: Verificar Instalación

```bash
# Conectarse a la base de datos
psql -h localhost -U openclaw_admin -d seguimiento_openclaw

# Dentro de psql, verificar tablas:
\dt

# Ver resumen de empleados (si tienes datos)
SELECT * FROM v_resumen_empleado;
```

## 📊 Estructura de la Base de Datos

### Tablas Principales

#### 1. **empleados** (modificada)
Tabla existente extendida con campos para integración OpenClaw.

```sql
- codigo (PK)
- nombre
- email
- telefono
- activo
- openclaw_user_id  -- ID único para vincular con OpenClaw
- fecha_creacion
- ultimo_acceso
```

#### 2. **proyectos**
Organización de tareas en proyectos.

```sql
- id (PK)
- nombre
- descripcion
- estado (activo, pausado, completado, cancelado)
- fecha_inicio
- fecha_fin_estimada
- responsable_codigo (FK → empleados)
- progreso_global (auto-calculado)
```

#### 3. **tareas**
Tareas individuales asignadas a empleados.

```sql
- id (PK)
- proyecto_id (FK → proyectos)
- empleado_codigo (FK → empleados)
- titulo
- descripcion
- prioridad (baja, media, alta, urgente)
- estado (pendiente, en_progreso, bloqueada, completada, cancelada)
- progreso (0-100)
- fecha_vencimiento
- etiquetas (array)
```

#### 4. **actualizaciones**
Registro de todos los seguimientos y updates.

```sql
- id (PK)
- tarea_id (FK → tareas)
- empleado_codigo (FK → empleados)
- tipo (progreso, comentario, blocker, pregunta, completado)
- contenido
- contenido_original  -- Texto original de OpenClaw
- progreso_anterior / progreso_nuevo
- metadata (JSONB)
- es_automatico
```

#### 5. **conversaciones**
Log de todas las interacciones con OpenClaw.

```sql
- id (PK)
- empleado_codigo (FK → empleados)
- canal (whatsapp, telegram, slack, etc)
- mensaje_original
- intent (update_task, create_task, report_blocker, etc)
- entities (JSONB - datos extraídos)
- procesado
```

#### 6. **blockers**
Impedimentos que bloquean tareas.

```sql
- id (PK)
- tarea_id (FK → tareas)
- descripcion
- severidad (baja, media, alta, critica)
- estado (activo, en_resolucion, resuelto)
- fecha_reporte
- fecha_resolucion
```

#### 7. **reportes_diarios**
Resúmenes automáticos de actividad.

```sql
- id (PK)
- empleado_codigo (FK → empleados)
- fecha
- tareas_completadas
- tareas_en_progreso
- blockers_activos
- horas_trabajadas
```

### Vistas Útiles

- **v_resumen_empleado**: Vista general de cada empleado
- **v_actividad_reciente**: Últimas 24 horas
- **v_tareas_riesgo**: Tareas vencidas o próximas a vencer
- **v_dashboard_proyectos**: Estado de todos los proyectos
- **v_productividad_semanal**: Métricas semanales

### Funciones Automáticas

- `auto_completar_tarea()`: Marca tarea como completada cuando progreso = 100
- `marcar_tarea_bloqueada()`: Cambia estado cuando se reporta blocker
- `verificar_desbloqueo_tarea()`: Reactiva tarea cuando se resuelven blockers
- `actualizar_progreso_proyecto()`: Recalcula progreso global
- `generar_reporte_diario()`: Crea resumen automático

## 💻 Uso

### Queries Útiles

Hemos incluido el archivo `queries_utiles.sql` con 30+ queries listos para usar:

```bash
# Ejecutar un query específico
psql -h localhost -U openclaw_admin -d seguimiento_openclaw -f queries_utiles.sql

# O copiar queries individuales desde el archivo
```

**Ejemplos de queries disponibles:**

1. Ver resumen de empleados
2. Actividad reciente
3. Tareas en riesgo
4. Productividad semanal
5. Blockers activos
6. Top empleados más activos
7. Y muchos más...

### Generar Reportes Diarios

```sql
-- Generar reporte para un empleado específico
SELECT generar_reporte_diario(1, CURRENT_DATE);

-- Generar para todos los empleados
DO $$
DECLARE emp RECORD;
BEGIN
    FOR emp IN SELECT codigo FROM empleados WHERE activo = true
    LOOP
        PERFORM generar_reporte_diario(emp.codigo, CURRENT_DATE);
    END LOOP;
END $$;
```

### Consultas Rápidas

```sql
-- Ver empleados activos
SELECT * FROM v_resumen_empleado;

-- Tareas que necesitan atención
SELECT * FROM v_tareas_riesgo;

-- Actividad del día
SELECT * FROM v_actividad_reciente WHERE DATE(creado_en) = CURRENT_DATE;

-- Dashboard de proyectos
SELECT * FROM v_dashboard_proyectos;
```

## 🔄 Próximos Pasos

### 1. Instalar OpenClaw

Después de configurar la base de datos, el siguiente paso es instalar OpenClaw:

```bash
# Instalar Node.js 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Instalar OpenClaw
npm install -g openclaw@latest

# Ejecutar wizard de configuración
openclaw onboard --install-daemon
```

### 2. Desarrollar Backend API

Crear un backend (Node.js o Python) que:
- Reciba webhooks de OpenClaw
- Procese mensajes con NLP
- Actualice la base de datos
- Envíe respuestas confirmación

**Ejemplo de estructura:**

```
backend/
├── src/
│   ├── server.js          # Servidor Express/FastAPI
│   ├── routes/
│   │   ├── webhooks.js    # Endpoints para OpenClaw
│   │   └── api.js         # API REST para consultas
│   ├── services/
│   │   ├── nlp.js         # Procesamiento de lenguaje natural
│   │   └── database.js    # Queries a PostgreSQL
│   └── config/
│       └── database.js    # Configuración de conexión
└── package.json
```

### 3. Configurar Webhooks de OpenClaw

En la configuración de OpenClaw (`.openclaw/config.json`):

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "seguimiento-actividades": {
          "enabled": true,
          "env": {
            "WEBHOOK_URL": "http://tu-servidor:3000/webhook/openclaw"
          }
        }
      }
    }
  }
}
```

### 4. Desarrollar Dashboard Web (Opcional)

Interfaz web para visualizar:
- Estado de proyectos
- Métricas del equipo
- Tareas en riesgo
- Reportes personalizados

**Tecnologías sugeridas:**
- Frontend: React, Vue, o Next.js
- Backend: Node.js con Express
- Gráficas: Chart.js o Recharts

## 📝 Ejemplos de Uso

### Escenario 1: Empleado actualiza progreso

**Usuario (por WhatsApp):**
> "Hola, avancé 30% en la tarea de migrar la base de datos"

**Sistema:**
1. OpenClaw recibe el mensaje
2. Webhook envía a backend
3. NLP identifica:
   - Intent: `update_task`
   - Entities: `{tarea: "migrar base de datos", progreso: 30}`
4. Backend busca tarea y actualiza progreso
5. Crea registro en `actualizaciones`
6. Responde: "✅ Actualizado! Tarea 'Migrar BD' ahora en 30%"

### Escenario 2: Reportar blocker

**Usuario:**
> "Estoy bloqueado en el deploy porque no tengo acceso al servidor de producción"

**Sistema:**
1. Intent: `report_blocker`
2. Entities: `{tarea: "deploy", razon: "sin acceso servidor producción"}`
3. Crea registro en `blockers`
4. Marca tarea como `bloqueada`
5. Notifica al responsable
6. Responde: "⚠️ Blocker registrado. Notifiqué al equipo de DevOps"

## 🔒 Seguridad

### Configuración de PostgreSQL

El script de instalación crea un usuario específico con permisos limitados:

```sql
-- Usuario solo tiene acceso a la base de datos específica
GRANT ALL PRIVILEGES ON DATABASE seguimiento_openclaw TO openclaw_admin;
```

### Acceso Remoto

Si habilitaste acceso remoto, asegura el firewall:

```bash
# Permitir solo desde IPs específicas
sudo ufw allow from 192.168.1.0/24 to any port 5432
```

### Backups

Configura backups automáticos:

```bash
# Crear directorio de backups
sudo mkdir -p /var/backups/postgresql

# Agregar a crontab (diario a las 2 AM)
0 2 * * * pg_dump -U openclaw_admin seguimiento_openclaw > /var/backups/postgresql/backup_$(date +\%Y\%m\%d).sql
```

## 🐛 Troubleshooting

### Error de conexión a PostgreSQL

```bash
# Verificar que PostgreSQL está corriendo
sudo systemctl status postgresql

# Reiniciar si es necesario
sudo systemctl restart postgresql

# Ver logs
sudo tail -f /var/log/postgresql/postgresql-16-main.log
```

### Tablas no creadas correctamente

```bash
# Re-ejecutar schema
psql -h localhost -U openclaw_admin -d seguimiento_openclaw -f schema_openclaw_tracking.sql
```

### Performance lento

```sql
-- Verificar índices
SELECT * FROM pg_indexes WHERE tablename IN ('tareas', 'actualizaciones', 'conversaciones');

-- Analizar query plan
EXPLAIN ANALYZE SELECT * FROM v_resumen_empleado;

-- Vacuum y analyze
VACUUM ANALYZE;
```

## 📧 Soporte

Para problemas o preguntas:
- Revisa el archivo `queries_utiles.sql`
- Consulta los logs de PostgreSQL
- Verifica la configuración en `.env`

## 📄 Licencia

Este proyecto es de uso interno. Asegúrate de revisar las licencias de:
- PostgreSQL (PostgreSQL License)
- OpenClaw (MIT License)

---

**¡Listo para el siguiente paso: Instalar OpenClaw!** 🚀
