# Manual del Supervisor - Sistema de Tareas por WhatsApp

---

## Bienvenido

Como supervisor, tienes dos roles en el sistema:

1. **Empleado** — Te reportas, haces tus tareas y registras tu salida como cualquier otro empleado.
2. **Supervisor** — Puedes consultar la asistencia, el avance de tareas, productividad y turnos de todo tu equipo, directamente desde WhatsApp.

Este manual cubre ambos roles, con enfasis en las funciones de supervision.

> Para las funciones basicas de empleado (reportarse, tareas, avance, salida), consulta el **Manual del Empleado**.

---

## 1. Tu menu de supervisor

Cuando el sistema no entienda un mensaje, te mostrara tus opciones. Las funciones exclusivas de supervisor aparecen con el icono 👔:

```
👔 Opciones de supervisor:
• "Dashboard"         - Resumen del dia
• "Asistencia"        - Quien ha llegado
• "Avance del equipo" - Estado de tareas
• "Productividad"     - Tiempos reales vs estandar
• "Turnos de hoy"     - Ver turnos, personal y sus tareas
```

Estas opciones solo funcionan si tu rol en el sistema es **manager** o **admin**. Si un empleado regular intenta usarlas, vera: *"Esa funcion es solo para supervisores."*

---

## 2. Dashboard — Resumen general del dia

**Como activarlo:** Escribe cualquiera de estas frases:
- **"dashboard"**
- "resumen del dia"
- "resumen del equipo"
- "como va el equipo"
- "como van las cosas"
- "estado general"
- "reporte del dia"

### Que muestra:

El dashboard te da una foto completa del dia en un solo mensaje:

```
TU:      dashboard
SISTEMA: 📊 *Dashboard del dia — Buenos dias, Maria*
         📅 2026-03-01

         👥 *ASISTENCIA* (3/5)
           ✅ Carlos (TM.a, 07:25)
           ✅ Pedro (TM.a, 07:30)
           ✅ Ana (TM.b, 07:45) → 🏠 salio 14:00
           ⏳ Roberto (T1) — sin reportarse
           ⏳ Diana (T1) — sin reportarse

         📋 *TAREAS* (8/20 completadas)
           🔄 3 en progreso
           📋 7 pendientes
           🚫 2 bloqueadas
           ✅ 8 completadas

           ▓▓▓▓░░░░░░ 40%

         👤 *POR EMPLEADO:*
           • Carlos: 4/5 (80%)
           • Pedro: 2/5 (40%) ⚠️1 bloq.
           • Ana: 2/5 (40%)
           • Roberto: 0/5 (0%)

         ⏱️ *Tiempo total registrado:* 12h 35m

         Di "asistencia", "avance del equipo", o "productividad"
         para mas detalle.
```

### Que significa cada parte:

| Seccion | Que muestra |
|---------|-------------|
| 👥 Asistencia | Quien llego, a que hora, y si ya salio |
| 📋 Tareas | Conteo total de tareas por estado + barra de progreso |
| 👤 Por empleado | Tareas completadas/total y porcentaje de cada persona |
| ⏱️ Tiempo | Horas totales de trabajo registradas por el equipo |

---

## 3. Asistencia — Quien ha llegado

**Como activarlo:**
- **"asistencia"**
- "quien llego"
- "quien ha llegado"
- "quien falta"
- "lista de asistencia"
- "presentes"
- "ausentes"
- "quien esta aqui"
- "quien vino"

### Ejemplo:

```
TU:      asistencia
SISTEMA: 👥 *Asistencia de hoy* (2026-03-01)

         ✅ *Presentes (3):*
           • Carlos Perez — TM.a (07:30-15:30)
             Entrada: 07:25
           • Pedro Lopez — TM.a (07:30-15:30)
             Entrada: 07:35 ⚠️ tarde
           • Ana Garcia — TM.b (08:00-16:00)
             Entrada: 07:55 → Salio: 14:00

         ⏳ *Sin reportarse (2):*
           • Roberto Diaz — T1 (06:00-14:00)
           • Diana Ruiz — T1 (06:00-14:00)

         📊 3 de 5 empleados presentes.
```

### Que significan los indicadores:

| Indicador | Significado |
|-----------|-------------|
| ✅ | Empleado se reporto |
| ⏳ | Empleado no se ha reportado |
| ⚠️ tarde | Llego despues de la hora de inicio del turno |
| → Salio: HH:MM | Ya registro su salida |

---

## 4. Avance del equipo — Estado de tareas

**Como activarlo:**
- **"avance del equipo"**
- "como van las tareas"
- "estado de tareas"
- "progreso del equipo"
- "que han hecho"
- "que se ha completado"

### Ejemplo:

```
TU:      avance del equipo
SISTEMA: 📋 *Avance de tareas del equipo* (2026-03-01)

         👤 *Carlos Perez*
            Completadas: 4/5 (80%) — Avance prom: 85%
            🔄 1 en progreso
            📋 0 pendientes

         👤 *Pedro Lopez*
            Completadas: 2/5 (40%) — Avance prom: 55%
            🔄 1 en progreso
            📋 1 pendientes
            🚫 1 bloqueadas

         👤 *Ana Garcia*
            Completadas: 2/5 (40%) — Avance prom: 60%
            🔄 1 en progreso
            📋 2 pendientes

         ⚠️ *Tareas bloqueadas:*
           • Pedro: Limpiar ascensores — ascensor 2 en mantenimiento
```

La seccion de **tareas bloqueadas** al final te muestra los problemas que necesitan tu atencion, con el motivo que el empleado reporto.

---

## 5. Productividad — Tiempos reales vs estandar

**Como activarlo:**
- **"productividad"**
- "rendimiento"
- "eficiencia"
- "reporte de tiempo"
- "tiempos del equipo"
- "cuanto tiempo"
- "horas trabajadas"

### Ejemplo:

```
TU:      productividad
SISTEMA: ⏱️ *Reporte de Productividad* (2026-03-01)

         📈 *RESUMEN GENERAL*
           Tareas completadas: 8/15
           Tiempo real: 6h 20m
           Tiempo estandar: 5h 45m
           🟡 Eficiencia: 91%

         👤 *POR EMPLEADO:*

         *Carlos*: 4/5 tareas
           ⏱️ Real: 3h 10m / Estandar: 2h 45m 🟡 87%

             ✅ Limpieza Entrada: 35min / 30min est.
             ✅ Limpiar Suelo: 50min / 45min est. ⚠️
             ✅ Sacar Basura: 15min / 20min est.
             ✅ Limpiar ascensores: 45min / 40min est.
             🔄 Limpieza Cristaleras: 45min / 30min est. ⚠️

         *Pedro*: 2/5 tareas
           ⏱️ Real: 1h 30m / Estandar: 1h 30m 🟢 100%
           🚫 1 bloqueadas

             ✅ Sacar Basura: 20min / 20min est.
             ✅ Limpiar Suelo: 40min / 45min est.
             🚫 Limpiar ascensores
             📋 Limpieza Banos
             📋 Limpieza Entrada

         _Eficiencia = tiempo estandar / tiempo real x 100_
         _🟢 >=100% | 🟡 80-99% | 🔴 <80%_
```

### Indicadores de eficiencia:

| Icono | Rango | Significado |
|-------|-------|-------------|
| 🟢 | 100% o mas | Excelente — termino mas rapido que el estandar |
| 🟡 | 80% - 99% | Aceptable — dentro del rango normal |
| 🔴 | Menos de 80% | Atencion — esta tardando mas de lo esperado |

| Icono por tarea | Significado |
|-----------------|-------------|
| ⚠️ | La tarea tardo 20% mas que el tiempo estandar |

---

## 6. Turnos de hoy — Consulta interactiva

**Como activarlo:**
- **"turnos de hoy"**
- "que turnos hay"
- "cuales turnos"
- "quien trabaja hoy"
- "personal de hoy"
- "que gente hay"
- "cuantos turnos"

Esta funcion es **interactiva** — te permite navegar en 3 niveles:

```
Nivel 1: Ver turnos del dia
    ↓ (eliges un turno)
Nivel 2: Ver empleados de ese turno
    ↓ (eliges un empleado)
Nivel 3: Ver tareas de ese empleado
```

### Ejemplo completo:

```
--- NIVEL 1: Turnos del dia ---

TU:      turnos de hoy
SISTEMA: 🕐 *Turnos de hoy* (2026-03-01)

         *1.* TM.a (07:30 - 15:30) — 3 empleado(s)
         *2.* TM.b (08:00 - 16:00) — 2 empleado(s)
         *3.* T1 (06:00 - 14:00) — 1 empleado(s)

         📊 Total: 6 empleados en 3 turno(s)

         De cual turno quieres ver el detalle? (numero o nombre)

--- NIVEL 2: Empleados del turno ---

TU:      1
SISTEMA: 👥 *TM.a* (07:30 - 15:30) — 3 empleado(s)

         *1.* Carlos Perez ✅ reportado 07:25
         *2.* Pedro Lopez ✅ reportado 07:35 ⚠️ tarde
         *3.* Roberto Diaz ⏳ sin reportar

         📊 Presentes: 2/3

         Ver tareas de alguien? (numero) o "plantillas"
         para ver las tareas del turno.

--- NIVEL 3a: Tareas de un empleado ---

TU:      1
SISTEMA: 📋 *Tareas de Carlos Perez — TM.a*

         ✅ *1.* Limpieza Entrada Principal (100%)
         ✅ *2.* Limpiar Suelo Maquina (100%)
         ✅ *3.* Sacar Basura (100%)
         🔄 *4.* Limpiar ascensores (50%)
         📋 *5.* Limpieza Cristaleras del CC 📌 (35%)

         📊 Resumen: 3 completadas, 1 en progreso, 1 pendientes
```

### Ver plantillas del turno

En el Nivel 2, en vez de elegir un empleado puedes escribir **"plantillas"** para ver que tareas tiene configuradas ese turno:

```
TU:      plantillas
SISTEMA: 📋 *Plantillas del TM.a*

         *1.* Limpieza Entrada Principal — 30 min
         *2.* Limpiar Suelo Maquina — 45 min
         *3.* Sacar Basura — 20 min
         *4.* Limpiar ascensores — 40 min

         Total: 4 tareas, 2h 15min estandar
```

---

## 7. Notificaciones automaticas que recibiras

Como supervisor, el sistema te envia notificaciones automaticas cuando ocurren eventos importantes:

### Tarea bloqueada

Cuando un empleado reporta un bloqueo, recibes:

```
SISTEMA: ⚠️ *Bloqueo reportado*
         Empleado: Pedro Lopez
         Tarea: Limpiar ascensores
         Motivo: el ascensor 2 esta en mantenimiento y no me dejan entrar
```

No necesitas hacer nada en el sistema — es solo informativo para que tomes accion. El empleado tambien ve un mensaje confirmando que fuiste notificado.

### Cuando NO te llega la notificacion

Si tu telefono no esta registrado en el sistema, el empleado vera:

```
⚠️ No se pudo notificar a tu supervisor (supervisor sin telefono registrado).
   Avisale directamente.
```

Asegurate de tener tu numero de telefono registrado en el sistema.

---

## 8. Entendiendo los tipos de tareas

### Tareas diarias (repetitivas)

Son las tareas que se generan automaticamente cada dia cuando un empleado se reporta. Se configuran una vez y aparecen todos los dias (o segun la frecuencia programada).

**Como se configuran:**
1. Se crea una **plantilla de tarea** (`task_templates`) con titulo, descripcion y tiempo estandar
2. Se vincula la plantilla a un **turno** (`shift_task_templates`) con la frecuencia deseada
3. Cada dia, al reportarse el empleado, el sistema genera automaticamente las instancias

**Frecuencias disponibles:**

| Frecuencia | Comportamiento |
|------------|----------------|
| **Diaria** | Aparece todos los dias laborales |
| **Semanal** | Aparece una vez por semana |
| **Mensual** | Aparece una vez al mes |
| **Ad-hoc** | Nunca se genera automaticamente (solo manual) |

**Dias de la semana:** Cada tarea puede tener un filtro de dias. Por ejemplo, una limpieza profunda puede estar configurada solo para lunes y viernes.

**Ejemplo:** El turno TM.a tiene 4 tareas diarias configuradas:
- Limpieza Entrada Principal (30 min)
- Limpiar Suelo Maquina (45 min)
- Sacar Basura (20 min)
- Limpiar ascensores (40 min)

Cuando Carlos se reporta para TM.a, automaticamente ve estas 4 tareas.

### Tareas nuevas (ad-hoc)

Los empleados pueden crear tareas sobre la marcha cuando surge algo inesperado durante su turno:

```
EMPLEADO: voy a hacer limpieza de derrame en pasillo 3
SISTEMA:  📋 Confirmas nueva tarea: "limpieza de derrame en pasillo 3"?
EMPLEADO: si
SISTEMA:  ✅ Nueva tarea creada e iniciada.
```

Estas tareas:
- Se registran para el dia y turno actual del empleado
- Quedan en el historial y reportes de productividad
- Te permiten ver que trabajo extra se hizo durante el dia
- Aparecen en el dashboard y reportes como cualquier otra tarea

### Tareas de largo plazo (backlog / proyectos) 📌

Son tareas grandes que se trabajan poco a poco durante varios dias o semanas. Se marcan con 📌 en la lista.

**Caracteristicas:**
- Tienen un **avance acumulativo** — el progreso se conserva dia a dia
- Pueden tener **fecha limite** (`due_date`)
- El empleado ve su avance total del proyecto, no solo lo de hoy
- Cuando el avance relativo del dia (+10%, +15%) se suma, se actualiza el avance global

**Ejemplo:** "Limpieza Cristaleras del CC (90 dias)" es un proyecto que se hace gradualmente:

```
Lunes:    El empleado avanza 5%  → Progreso total: 35%
Martes:   El empleado avanza 3%  → Progreso total: 38%
Miercoles: El empleado avanza 7% → Progreso total: 45%
```

Cada dia la tarea aparece en la lista del empleado con su avance acumulado:

```
📋 *4.* Limpieza Cristaleras del CC (90dias) 📌 (45%)
```

---

## 9. Como funciona el sistema de turnos

### Estructura basica

```
Turno (shift_template)
  → define horario: 07:30 - 15:30
  → tiene tareas asignadas (shift_task_templates)

Asignacion (shift_assignment)
  → conecta un empleado con un turno para un dia especifico
  → work_date: 2026-03-01
  → shift_id: TM.a
  → employee_id: Carlos
```

### Flujo diario

```
1. Tú o un admin crean las asignaciones de turno para cada dia
   (shift_assignments: "Carlos → TM.a → 2026-03-01")

2. El cron verifica cada 5 minutos si hay empleados que deberian
   estar trabajando pero no se han reportado

3. Si un empleado no se reporta 5 min despues de su hora de inicio,
   el sistema le envia un recordatorio por WhatsApp

4. Cuando el empleado se reporta, el sistema:
   - Registra su check-in
   - Genera las tareas diarias del turno
   - Le muestra su lista de tareas

5. Al final del turno + 5 min, si no se ha despedido,
   le envia un recordatorio de salida

6. Si no responde en 20 minutos, cierra su turno automaticamente
```

### Empleados con multiples turnos

Un empleado puede tener dos turnos en el mismo dia (ej. mañana y noche). El sistema:
- Detecta automaticamente cual es el turno activo segun la hora
- Muestra solo las tareas del turno actual (no mezcla turnos)
- Al hacer checkout del primer turno y reportarse para el segundo, ve las tareas del nuevo turno

### Tolerancia de llegada temprana

- **Dentro de 30 minutos antes:** Se acepta el check-in con un mensaje de felicitacion
- **Mas de 30 minutos antes:** Se rechaza el check-in y se pide que vuelva mas tarde

El tiempo de tolerancia es configurable (`SHIFT_EARLY_TOLERANCE_MINUTES`).

---

## 10. Recordatorios automaticos del sistema

### Recordatorio de inicio de turno

**Cuando:** 5 a 15 minutos despues de que empieza el turno, si el empleado no se ha reportado.

```
SISTEMA: 👋 Hola Carlos! Tu turno TM.a empezo a las 07:30.
         Ya estas en tus labores?
         Responde "me reporto" para registrar tu llegada
         y ver tus tareas asignadas.
```

- Se envia **una sola vez** (no repite)
- Solo si el empleado tiene telefono registrado
- Solo en dias laborales (respeta el calendario de turnos)

### Recordatorio de fin de turno

**Cuando:** 5 minutos despues de que termina el turno, si el empleado no se ha despedido.

```
SISTEMA: ⏰ Carlos, tu turno TM.a termino a las 15:30.
         📊 Tareas completadas: 4/5
         Ya terminaste tu jornada?
         Responde "ya me voy" para registrar tu salida,
         o "aun no" si sigues trabajando.
```

### Cierre automatico

**Cuando:** 20 minutos despues del recordatorio, si el empleado no respondio.

```
SISTEMA: 📋 Carlos, tu turno fue cerrado automaticamente.
         Si aun estas trabajando, avisa a tu supervisor.
         Buen descanso! 🌙
```

El cierre automatico:
- Registra la salida con marca `"Cierre automatico por sistema"` (diferenciable del manual)
- Cierra cualquier registro de tiempo abierto
- Se puede verificar en los reportes quien fue cerrado automaticamente

### Si el empleado dice que sigue trabajando

El empleado puede responder "aun no" o "sigo trabajando" al recordatorio:

```
SISTEMA: 👍 Entendido Carlos, sigue con lo tuyo.
         Te volvere a preguntar en 20 minutos.
```

El sistema vuelve a preguntar despues del tiempo configurado.

---

## 11. Tablas de base de datos que debes conocer

No necesitas acceder directamente a la base de datos, pero es util entender la estructura:

### Tablas de configuracion (se llenan una vez)

| Tabla | Para que sirve | Ejemplo |
|-------|---------------|---------|
| `employees` | Empleados registrados | Carlos, role: employee |
| `shift_templates` | Definicion de turnos | TM.a: 07:30-15:30 |
| `task_templates` | Plantillas de tareas | "Limpieza Entrada", 30 min |
| `shift_task_templates` | Que tareas tiene cada turno | TM.a → Limpieza Entrada (diaria) |
| `locations` | Ubicaciones/areas | "Piso 1", "Edificio A" |
| `shift_calendar` | Dias no laborales por turno | TM.a: 2026-12-25 no es laborable |

### Tablas de asignacion (se llenan cada dia)

| Tabla | Para que sirve | Ejemplo |
|-------|---------------|---------|
| `shift_assignments` | Quien trabaja que turno cada dia | Carlos → TM.a → 2026-03-01 |
| `tasks` | Tareas de largo plazo / backlog | Pintar bodega, prioridad 3 |

### Tablas que se llenan automaticamente

| Tabla | Se llena cuando... |
|-------|-------------------|
| `task_instances` | Empleado se reporta (genera tareas del turno) |
| `checkins` | Empleado se reporta o sale |
| `task_time_log` | Empleado inicia/termina una tarea (cronometro) |
| `chat_messages` | Cualquier mensaje enviado o recibido |
| `outbox_messages` | Sistema necesita enviar un mensaje proactivo |
| `supervisor_escalations` | Empleado reporta un bloqueo |
| `nlp_extractions` | Se analiza cada mensaje del empleado |

---

## 12. Datos necesarios para que todo funcione

Para que un empleado reciba sus tareas y recordatorios, necesitas tener:

### Minimo indispensable:

1. **Empleado registrado** en `employees` con:
   - `full_name` (nombre completo)
   - `phone_e164` (telefono con formato internacional: +502XXXXXXXX)
   - `role` (employee, manager, o admin)
   - `is_active = true`
   - `supervisor_id` (para que los bloqueos te lleguen a ti)

2. **Turno creado** en `shift_templates` con:
   - `shift_code` (codigo del turno: TM.a, T1, etc.)
   - `start_time` y `end_time`
   - `is_active = true`

3. **Tareas vinculadas al turno** en `shift_task_templates` con:
   - `shift_id` → cual turno
   - `template_id` → cual tarea
   - `frequency` → diaria, semanal, mensual
   - `standard_minutes` → tiempo estimado
   - `is_active = true`

4. **Asignacion del dia** en `shift_assignments` con:
   - `work_date` → fecha
   - `shift_id` → turno
   - `employee_id` → empleado

### Sin esto, no funciona:

| Falta | Consecuencia |
|-------|-------------|
| Empleado sin telefono | No recibe recordatorios |
| Sin shift_assignment del dia | No le aparece turno ni tareas |
| Sin shift_task_templates | Turno sin tareas automaticas |
| Empleado sin supervisor_id | Bloqueos no se escalan |
| shift_template con is_active=false | Turno ignorado |

---

## 13. Ejemplo completo de un dia como supervisor

```
--- 07:00 - Llegas temprano y te reportas ---

TU:      me reporto
SISTEMA: ✅ Reporte registrado, Maria!
         Turno: T2 (07:00 - 16:00)
         (tus tareas de supervision)

--- 07:40 - Verificas quien llego ---

TU:      asistencia
SISTEMA: 👥 *Asistencia de hoy*
         ✅ *Presentes (3):*
           • Carlos Perez — TM.a (07:30-15:30) Entrada: 07:25
           • Pedro Lopez — TM.a (07:30-15:30) Entrada: 07:35 ⚠️ tarde
           • Ana Garcia — TM.b (08:00-16:00) Entrada: 07:55
         ⏳ *Sin reportarse (1):*
           • Roberto Diaz — T1 (06:00-14:00)
         📊 3 de 4 empleados presentes.

--- 09:00 - Ves como va el equipo ---

TU:      dashboard
SISTEMA: 📊 *Dashboard del dia...*
         (resumen completo con asistencia, tareas y progreso)

--- 10:30 - Recibes una notificacion ---

SISTEMA: ⚠️ *Bloqueo reportado*
         Empleado: Pedro Lopez
         Tarea: Limpiar ascensores
         Motivo: el ascensor 2 esta en mantenimiento

--- 10:35 - Revisas los turnos para ver detalles ---

TU:      turnos de hoy
SISTEMA: 🕐 *Turnos de hoy*
         *1.* TM.a (07:30 - 15:30) — 2 empleados
         *2.* TM.b (08:00 - 16:00) — 1 empleado
         *3.* T1 (06:00 - 14:00) — 1 empleado
         De cual turno quieres ver el detalle?

TU:      1
SISTEMA: 👥 *TM.a* (07:30 - 15:30) — 2 empleados
         *1.* Carlos Perez ✅ reportado 07:25
         *2.* Pedro Lopez ✅ reportado 07:35 ⚠️ tarde
         Ver tareas de alguien?

TU:      2
SISTEMA: 📋 *Tareas de Pedro Lopez — TM.a*
         ✅ *1.* Sacar Basura (100%)
         ✅ *2.* Limpiar Suelo (100%)
         🚫 *3.* Limpiar ascensores
            ⚠️ Bloqueado: ascensor 2 en mantenimiento
         📋 *4.* Limpieza Banos
         📋 *5.* Limpieza Entrada

--- 12:00 - Revisas productividad ---

TU:      productividad
SISTEMA: ⏱️ *Reporte de Productividad*
         (tiempos reales vs estandar por empleado y tarea)

--- 15:30 - Fin del dia ---

TU:      ya me voy
SISTEMA: 👋 Salida registrada, Maria!
         (resumen de tu dia)
```

---

## 14. Preguntas frecuentes del supervisor

### El empleado dice que no le llegan mensajes
Verifica que:
1. Su telefono este registrado en formato internacional (+502XXXXXXXX)
2. Tenga `is_active = true`
3. Tenga una `shift_assignment` para el dia de hoy
4. El turno asignado tenga `is_active = true`

### Un empleado no tiene tareas al reportarse
Verifica que:
1. El turno asignado tenga tareas vinculadas en `shift_task_templates`
2. Las plantillas de tarea tengan `is_active = true`
3. La frecuencia de la tarea aplique para hoy (dia de la semana correcto)

### Los bloqueos no me llegan
Verifica que:
1. Tu `employee_id` este como `supervisor_id` en la ficha del empleado
2. Tu numero de telefono este registrado en el sistema

### Un empleado tiene dos turnos el mismo dia
El sistema lo soporta. Cuando el empleado se reporta, solo ve las tareas del turno actual. Al salir del primero y reportarse al segundo, ve las tareas del nuevo turno.

### Quiero ver las plantillas de un turno sin preguntar empleado por empleado
Usa la funcion de **turnos de hoy**, elige el turno, y luego escribe **"plantillas"**.

### Un empleado fue cerrado automaticamente pero seguia trabajando
El cierre automatico ocurre 20 minutos despues del recordatorio de fin de turno. El empleado debe responder "aun no" o "sigo trabajando" cuando reciba el recordatorio. Si no responde, el sistema asume que ya se fue.

En los reportes puedes distinguir el cierre automatico del manual consultando la base de datos:
- Manual: `answer_text = 'Empleado reporto salida'`
- Automatico: `answer_text = 'Cierre automatico por sistema'`

### Quiero agregar una tarea nueva a un turno
Esto se hace desde la base de datos:
1. Crear la plantilla en `task_templates` (titulo, descripcion, minutos estandar)
2. Vincularla al turno en `shift_task_templates` (turno, frecuencia, minutos)
3. A partir del dia siguiente, los empleados veran la nueva tarea automaticamente

### Que pasa si cambio las plantillas de tarea a mitad de dia
Las tareas se generan una sola vez al momento en que el empleado se reporta. Si cambias una plantilla durante el dia, los cambios aplicaran a partir del dia siguiente.

---

## 15. Resumen de todos los comandos de supervisor

| Comando | Que hace | Frases aceptadas |
|---------|----------|-------------------|
| **Dashboard** | Resumen completo del dia | "dashboard", "resumen del dia", "como va el equipo" |
| **Asistencia** | Quien llego y quien falta | "asistencia", "quien llego", "quien falta", "presentes" |
| **Avance** | Estado de tareas por empleado | "avance del equipo", "como van las tareas", "que han hecho" |
| **Productividad** | Tiempos reales vs estandar | "productividad", "rendimiento", "eficiencia", "tiempos" |
| **Turnos** | Turnos → empleados → tareas | "turnos de hoy", "quien trabaja hoy", "que turnos hay" |

Ademas de estos, tienes todos los comandos de empleado:

| Comando | Frases |
|---------|--------|
| Reportarte | "me reporto", "ya llegue" |
| Ver tus tareas | "mis tareas", "que tengo" |
| Iniciar tarea | "empiezo con la 1" |
| Avance | "50%", "llevo la mitad" |
| Terminar | "listo", "ya termine" |
| Bloqueo | "bloqueado", "no puedo" |
| Tarea nueva | "voy a hacer [descripcion]" |
| Salida | "ya me voy", "me retiro" |

---

## 16. Contacto tecnico

Si necesitas cambios en la configuracion del sistema (agregar empleados, crear turnos, modificar plantillas de tareas), contacta al administrador del sistema.
