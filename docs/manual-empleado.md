# Manual del Empleado - Sistema de Tareas por WhatsApp

---

## Bienvenido

Este sistema te permite registrar tu llegada, ver tus tareas del dia, reportar tu avance y registrar tu salida, todo desde WhatsApp. Solo necesitas escribir mensajes sencillos y el sistema te guiara.

---

## 1. Como funciona tu dia de trabajo

Tu dia en el sistema tiene 4 pasos:

```
1. LLEGADA     →  Te reportas al inicio de tu turno
2. TAREAS      →  Ves tus tareas y las vas completando
3. AVANCE      →  Reportas como vas en cada tarea
4. SALIDA      →  Te despides al terminar tu turno
```

No necesitas memorizar comandos exactos. El sistema entiende muchas formas de decir las cosas. Escribe como le hablarias a un companero.

---

## 2. Registro de llegada (Check-in)

Cuando llegues a trabajar, escribe cualquiera de estas frases:

- **"me reporto"**
- "ya llegue"
- "presente"
- "aqui estoy"
- "ya estoy"
- "buenos dias"

### Ejemplo de conversacion:

```
TU:      me reporto
SISTEMA: ✅ Reporte registrado, Carlos!

         Turno: TM.a (07:30 - 15:30)

         *Tus tareas para hoy:*

         📋 *1.* Limpieza Entrada Principal - Piso 1
         📋 *2.* Limpiar Suelo Maquina Planta Baja
         📋 *3.* Sacar Basura
         📋 *4.* Limpiar ascensores

         📊 Resumen: 0 completadas, 0 en progreso, 4 pendientes

         Puedes decirme:
         • "Empiezo con [tarea]" para iniciar
         • "Ya termine" al completar
         • Un porcentaje como "50%" para reportar avance
```

### Si llegas temprano

Si llegas antes de tu hora pero dentro de los 30 minutos previos, el sistema te acepta y te felicita:

```
TU:      me reporto
SISTEMA: ✅ Reporte registrado, Carlos!
         Turno: TM.a (07:30 - 15:30) — llegaste 15 min antes, bien! 👏
```

Si llegas demasiado temprano (mas de 30 minutos antes), te pedira que vuelvas despues:

```
TU:      me reporto
SISTEMA: ⏰ Carlos, tu turno TM.a empieza a las 07:30 (faltan ~45 minutos).
         Vuelve a reportarte cuando estes mas cerca de tu hora de entrada.
```

---

## 3. Ver tus tareas

En cualquier momento puedes ver tu lista de tareas escribiendo:

- **"mis tareas"**
- "que tengo"
- "que me toca"
- "pendientes"
- "tareas del dia"

### Ejemplo:

```
TU:      mis tareas
SISTEMA: *Tus tareas para hoy:*

         ✅ *1.* Limpieza Entrada Principal (100%)
         🔄 *2.* Limpiar Suelo Maquina (50%)
         📋 *3.* Sacar Basura
         📋 *4.* Limpiar ascensores

         📊 Resumen: 1 completadas, 1 en progreso, 2 pendientes
```

### Que significa cada icono:

| Icono | Significado |
|-------|-------------|
| 📋 | Tarea pendiente (aun no la empiezas) |
| 🔄 | Tarea en progreso (la estas haciendo) |
| ✅ | Tarea completada |
| 🚫 | Tarea bloqueada (tienes un problema) |
| 📌 | Tarea de proyecto a largo plazo |

---

## 4. Tipos de tareas

### Tareas diarias (repetitivas)

Son las que aparecen automaticamente cada dia cuando te reportas. Son las tareas habituales de tu turno: limpieza, mantenimiento, sacar basura, etc. El supervisor las configura una vez y aparecen todos los dias.

```
📋 *1.* Limpieza Entrada Principal - Piso 1
📋 *2.* Limpiar Suelo Maquina Planta Baja
📋 *3.* Sacar Basura
```

### Tareas nuevas (ad-hoc)

A veces durante tu turno surge algo que no estaba planeado. Tu puedes crear una nueva tarea para que quede registrada.

```
TU:      voy a hacer limpieza de derrame en pasillo 3
SISTEMA: 📋 Confirmas nueva tarea: "limpieza de derrame en pasillo 3"?
         Puedes agregar detalles o responde *si* para iniciar.

TU:      si
SISTEMA: ✅ Nueva tarea creada e iniciada: "limpieza de derrame en pasillo 3"
```

### Tareas de proyecto (largo plazo) 📌

Algunas tareas son parte de un proyecto mas grande que toma varios dias. Estas se marcan con 📌 y su avance se va acumulando dia a dia. Por ejemplo, una limpieza profunda que se hace poco a poco.

```
📋 *4.* Limpieza Cristaleras del CC (90dias) 📌 (35%)
```

El porcentaje muestra cuanto llevas en total del proyecto, no solo lo de hoy.

---

## 5. Trabajar con tus tareas

### Iniciar una tarea

Cuando vayas a empezar una tarea, puedes decirlo de varias formas:

- **"empiezo con la 1"** (por numero)
- "voy con la limpieza"  (por nombre)
- "empiezo con la primera" (por orden)
- "arranco con la 3"

```
TU:      empiezo con la 1
SISTEMA: 🔄 Iniciaste la tarea "Limpieza Entrada Principal".
         Avisame cuando avances o termines.
```

### Reportar avance

Mientras trabajas en una tarea, puedes decir como vas. **No necesitas repetir el nombre de la tarea** porque el sistema sabe cual tienes en progreso:

**Con porcentaje exacto:**
- "50%"
- "voy en el 75%"
- "llevo el 30%"

**Con palabras:**
- "llevo la mitad" (= 50%)
- "casi termino" (= 85%)
- "ya mero" (= 85%)
- "falta poco" (= 85%)

**Sumando avance (relativo):**
- "10% mas" (suma 10% a lo que llevas)
- "avance un 20%" (suma 20%)

### Ejemplo de conversacion completa con avance:

```
TU:      empiezo con la 2
SISTEMA: 🔄 Iniciaste la tarea "Limpiar Suelo Maquina".
         Avisame cuando avances o termines.

--- (pasa un rato trabajando) ---

TU:      llevo la mitad
SISTEMA: 📊 Tarea "Limpiar Suelo Maquina" actualizada. Avance: 50%

--- (sigues trabajando) ---

TU:      ya casi termino
SISTEMA: 💪 Tarea "Limpiar Suelo Maquina" actualizada. Avance: 85%

--- (terminas) ---

TU:      listo
SISTEMA: ✅ Excelente! Tarea "Limpiar Suelo Maquina" completada.
         Vas a iniciar otra tarea? Dime cual o escribe "mis tareas"
         para ver las pendientes.
```

### Completar una tarea

Cuando termines una tarea, escribe:

- **"ya termine"**
- "listo"
- "terminado"
- "completado"
- "hecho"
- "100%"

Si tienes una tarea en progreso, el sistema sabe que te refieres a esa:

```
TU:      ya termine
SISTEMA: ✅ Excelente! Tarea "Sacar Basura" completada.
```

### Completar tarea por numero

Si no tienes tarea activa pero quieres marcar una como terminada:

```
TU:      ya termine
SISTEMA: Cual tarea completaste? Responde con el numero, "todas",
         o varios numeros (ej: 1, 3, 5):

         📋 1. Limpieza Entrada Principal
         🔄 2. Limpiar Suelo Maquina (50%)
         📋 3. Sacar Basura

TU:      la 3
SISTEMA: ✅ Tarea "Sacar Basura" completada!
```

### Completar varias tareas a la vez

```
TU:      termine la 1 y la 3
SISTEMA: ✅ 2 tareas completadas:
         • Limpieza Entrada Principal
         • Sacar Basura

TU:      todas
SISTEMA: ✅ 3 tareas completadas:
         • Limpieza Entrada Principal
         • Limpiar Suelo Maquina
         • Sacar Basura
         🎉 Excelente trabajo! No tienes mas tareas pendientes.
```

---

## 6. Dejar una tarea a medias y tomar otra

Puedes dejar una tarea en la que estas trabajando y empezar otra. El sistema guarda tu avance automaticamente:

```
TU:      empiezo con la 1
SISTEMA: 🔄 Iniciaste "Limpieza Entrada Principal".

TU:      50%
SISTEMA: 📊 Tarea "Limpieza Entrada Principal" actualizada. Avance: 50%

TU:      empiezo con la 3
SISTEMA: 🔄 Iniciaste "Sacar Basura".
         (La tarea anterior queda guardada con su avance del 50%)

--- (mas tarde vuelves a la primera) ---

TU:      empiezo con la 1
SISTEMA: 🔄 Iniciaste "Limpieza Entrada Principal". (Retomada al 50%)

TU:      listo
SISTEMA: ✅ Tarea "Limpieza Entrada Principal" completada.
```

Tu avance nunca se pierde. Puedes ir y venir entre tareas.

---

## 7. Reportar un problema o bloqueo

Si algo te impide continuar con una tarea (falta material, equipo danado, acceso cerrado, etc.), puedes reportarlo:

- **"bloqueado"**
- "no puedo continuar"
- "tengo un problema"
- "no funciona"
- "no hay material"
- "necesito ayuda"

### Ejemplo:

```
TU:      bloqueado
SISTEMA: Que te esta bloqueando en "Limpiar ascensores"?
         Describe el problema para notificar a tu supervisor.

TU:      el ascensor 2 esta en mantenimiento y no me dejan entrar
SISTEMA: ⚠️ Tarea "Limpiar ascensores" marcada como bloqueada.
         Motivo: el ascensor 2 esta en mantenimiento y no me dejan entrar

         ✅ Se notifico a tu supervisor.
```

**Importante:** Cuando reportas un bloqueo, tu supervisor recibe una notificacion automatica con el detalle del problema. No necesitas buscarlo para avisarle.

---

## 8. Formas de referirte a tus tareas

No necesitas escribir el nombre completo de una tarea. Puedes referirte a ella de varias formas:

### Por numero (segun tu lista):
```
"la 1", "el 2", "tarea 3", "la primera", "#4"
```

### Por nombre parcial:
```
"la de limpieza", "basura", "ascensores"
```

### Combinando accion + referencia:
```
"empiezo con la 2"
"termine la 1"
"la 3 al 50%"
"la 4 bloqueada"
"termine la 1 y voy con la 2"
"la 2 al 50% y la 3 al 30%"
```

---

## 9. Registro de salida (Check-out)

Cuando termines tu turno, escribe:

- **"ya me voy"**
- "me voy"
- "me retiro"
- "fin de turno"
- "ya sali"

### Ejemplo:

```
TU:      ya me voy
SISTEMA: 👋 Salida registrada, Carlos!

         ⏰ Entrada: 07:25
         ⏰ Salida: 15:30
         ⏱️ Tiempo trabajado: 8h 5m
         📋 Turno: TM.a (07:30 - 15:30)

         ✅ Tareas completadas: 3 de 4
         ⚠️ Pendientes sin completar: 1
           • Limpiar ascensores

         Buen trabajo hoy! Que descanses. 🌙
```

### Si no te despides

Si tu turno termina y no te despides, el sistema te enviara un recordatorio unos minutos despues:

```
SISTEMA: ⏰ Carlos, tu turno TM.a termino a las 15:30.

         📊 Tareas completadas: 3/4

         Ya terminaste tu jornada?

         Responde "ya me voy" para registrar tu salida,
         o "aun no" si sigues trabajando.
```

**Si no respondes en 20 minutos**, el sistema cierra tu turno automaticamente y te avisa:

```
SISTEMA: 📋 Carlos, tu turno fue cerrado automaticamente.
         Si aun estas trabajando, avisa a tu supervisor.
         Buen descanso! 🌙
```

### Si necesitas mas tiempo

Si el sistema te pregunta si ya terminaste pero aun sigues trabajando:

```
SISTEMA: Ya terminaste tu jornada?
TU:      aun no
SISTEMA: 👍 Entendido Carlos, sigue con lo tuyo.
         Te volvere a preguntar en 20 minutos.

         📋 Tareas pendientes:
         🔄 Limpiar ascensores (50%)

         Cuando termines, escribe "ya me voy".
```

---

## 10. Recordatorio de inicio de turno

Si tu turno ya empezo y no te has reportado, a los 5 minutos el sistema te enviara un recordatorio:

```
SISTEMA: 👋 Hola Carlos! Tu turno TM.a empezo a las 07:30.

         Ya estas en tus labores?

         Responde "me reporto" para registrar tu llegada
         y ver tus tareas asignadas.
```

Solo tienes que responder **"me reporto"** y el sistema registra tu llegada.

---

## 11. Resumen de frases utiles

### Para tu jornada:

| Que quieres hacer | Que escribir |
|---|---|
| Registrar llegada | "me reporto", "ya llegue", "presente" |
| Ver tus tareas | "mis tareas", "que tengo", "pendientes" |
| Registrar salida | "ya me voy", "me retiro", "fin de turno" |

### Para tus tareas:

| Que quieres hacer | Que escribir |
|---|---|
| Iniciar una tarea | "empiezo con la 1", "voy con la limpieza" |
| Reportar avance | "50%", "llevo la mitad", "casi termino" |
| Sumar avance | "10% mas", "avance un 20%" |
| Terminar tarea | "listo", "ya termine", "terminado" |
| Terminar varias | "termine 1, 3, 5" o "todas" |
| Reportar bloqueo | "bloqueado", "no puedo", "necesito ayuda" |
| Crear tarea nueva | "voy a hacer [descripcion]" |

### Si sigues trabajando despues de tu hora:

| Que quieres hacer | Que escribir |
|---|---|
| Decir que sigues | "aun no", "sigo trabajando", "no he terminado" |

---

## 12. Ejemplo completo de un dia de trabajo

```
--- 07:25 - Llegas al trabajo ---

TU:      buenos dias
SISTEMA: Buenos dias, Carlos! 👋
         Tu turno TM.a es de 07:30 a 15:30.
         Tienes 4 tarea(s) pendientes hoy.
         Escribe "mis tareas" para ver el detalle.

TU:      me reporto
SISTEMA: ✅ Reporte registrado, Carlos!
         Turno: TM.a (07:30 - 15:30) — llegaste 5 min antes, bien! 👏

         *Tus tareas para hoy:*
         📋 *1.* Limpieza Entrada Principal
         📋 *2.* Limpiar Suelo Maquina
         📋 *3.* Sacar Basura
         📋 *4.* Limpiar ascensores

--- 07:30 - Empiezas a trabajar ---

TU:      empiezo con la 1
SISTEMA: 🔄 Iniciaste la tarea "Limpieza Entrada Principal".

--- 08:15 - Terminas la primera ---

TU:      listo
SISTEMA: ✅ Excelente! Tarea "Limpieza Entrada Principal" completada.

--- 08:20 - Empiezas la siguiente ---

TU:      voy con la 2
SISTEMA: 🔄 Iniciaste la tarea "Limpiar Suelo Maquina".

--- 09:00 - Reportas avance ---

TU:      llevo la mitad
SISTEMA: 📊 Tarea "Limpiar Suelo Maquina" actualizada. Avance: 50%

--- 09:15 - Surge algo urgente ---

TU:      voy a hacer limpieza de derrame en cafeteria
SISTEMA: 📋 Confirmas nueva tarea: "limpieza de derrame en cafeteria"?
TU:      si
SISTEMA: ✅ Nueva tarea creada e iniciada.

--- 09:30 - Terminas lo urgente ---

TU:      ya termine
SISTEMA: ✅ Tarea "limpieza de derrame en cafeteria" completada.

--- 09:35 - Vuelves a la tarea que dejaste ---

TU:      empiezo con la 2
SISTEMA: 🔄 Iniciaste "Limpiar Suelo Maquina". (Retomada al 50%)

TU:      20% mas
SISTEMA: 📊 Tarea actualizada. +20% → Ahora vas en 70%

TU:      listo
SISTEMA: ✅ Tarea "Limpiar Suelo Maquina" completada.

--- 10:00 - Sacas la basura rapido ---

TU:      empiezo la 3
SISTEMA: 🔄 Iniciaste "Sacar Basura".

TU:      terminado
SISTEMA: ✅ Tarea "Sacar Basura" completada.

--- 10:30 - Intentas limpiar ascensores ---

TU:      empiezo con la 4
SISTEMA: 🔄 Iniciaste "Limpiar ascensores".

TU:      no puedo, el ascensor 2 esta en mantenimiento
SISTEMA: ⚠️ Tarea "Limpiar ascensores" marcada como bloqueada.
         Motivo: el ascensor 2 esta en mantenimiento
         ✅ Se notifico a tu supervisor.

--- 10:45 - Ves como vas ---

TU:      mis tareas
SISTEMA: *Tus tareas para hoy:*
         ✅ *1.* Limpieza Entrada Principal (100%)
         ✅ *2.* Limpiar Suelo Maquina (100%)
         ✅ *3.* Sacar Basura (100%)
         🚫 *4.* Limpiar ascensores
            ⚠️ Bloqueado: el ascensor 2 esta en mantenimiento
         ✅ *5.* limpieza de derrame en cafeteria (100%)
         📊 Resumen: 3 completadas, 0 en progreso, 0 pendientes

--- 15:30 - Fin de turno ---

TU:      ya me voy
SISTEMA: 👋 Salida registrada, Carlos!
         ⏰ Entrada: 07:25
         ⏰ Salida: 15:30
         ⏱️ Tiempo trabajado: 8h 5m
         📋 Turno: TM.a (07:30 - 15:30)
         ✅ Tareas completadas: 4 de 5
         ⚠️ Pendientes sin completar: 1
           • Limpiar ascensores
         Buen trabajo hoy! Que descanses. 🌙
```

---

## 13. Errores comunes y como solucionarlos

### "No te tenemos registrado en el sistema"
Tu numero de telefono no esta dado de alta. Contacta a tu supervisor para que te registre.

### El sistema no entiende tu mensaje
Intenta ser mas directo. En vez de escribir un parrafo, usa frases cortas:
- En vez de: "oye pues ya mira es que ya acabe con lo de la entrada"
- Escribe: "termine la 1"

### Mandaste un porcentaje pero no sabia a cual tarea
Si no tienes una tarea activa (en progreso), el sistema te preguntara a cual tarea aplicar el avance. Solo responde con el numero.

### Te aparecen tareas que no son de tu turno
Esto no deberia pasar. Si ves tareas que no te corresponden, avisa a tu supervisor.

### No te llego el recordatorio de inicio de turno
El sistema envia el recordatorio entre 5 y 15 minutos despues de que empieza tu turno. Si no llego, puede ser un problema de conexion. Simplemente escribe "me reporto" por tu cuenta.

### Quieres cancelar algo
Si el sistema te esta preguntando algo y quieres cancelar, escribe:
- "cancelar"
- "no"
- "nada"
- "olvida"

### Te equivocaste de tarea
Si marcaste la tarea incorrecta como terminada, puedes reiniciarla:
```
TU:      empiezo con la 3
SISTEMA: 🔄 Reiniciaste la tarea "Sacar Basura" (estaba completada).
```

---

## 14. Consejos

1. **Reportate siempre al llegar.** Es lo primero que debes hacer. Escribe "me reporto" y listo.

2. **No necesitas memorizar comandos.** Escribe de forma natural. "ya termine", "listo", "hecho" — todas funcionan igual.

3. **Si tienes una tarea activa, no necesitas nombrarla.** El sistema sabe cual estas haciendo. Solo di "50%" o "ya termine".

4. **Reporta los problemas.** Si algo te bloquea, dilo. Tu supervisor recibe la notificacion automaticamente.

5. **No te preocupes si se te olvida despedirte.** El sistema te recordara y si no respondes, cierra tu turno solo.

6. **Los numeros de tarea son fijos.** La tarea 1 siempre sera la 1 aunque la completes. No cambian de numero durante el dia.

7. **Puedes crear tareas nuevas.** Si surge algo inesperado, escribe "voy a hacer [lo que paso]" y queda registrado.

---

## 15. Contacto

Si tienes dudas o problemas con el sistema, contacta a tu supervisor directamente o escribele por WhatsApp. El tiene acceso a funciones adicionales para ayudarte.
