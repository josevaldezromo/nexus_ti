# Nexo TI

**Conectamos soluciones.** Nexo TI es el portal interno de soporte para Bormine, Didiamant y Corpdiam. La aplicación utiliza Node.js, PostgreSQL y sesiones protegidas por cookie. Está preparada para ejecutarse como contenedor en EasyPanel.

## Funciones implementadas

- Inicio de sesión con cuentas creadas por un administrador; no hay registro público.
- Cambio de contraseña personal; al cambiarla se invalidan las otras sesiones.
- Acceso de administrador o colaborador asociado a una o varias empresas.
- Colaboradores: crean citas y tickets; pueden tener una o varias empresas asignadas, consultar todos sus registros y usar el selector superior para filtrar el portal por una empresa o por todas sus empresas.
- Administradores: consultan tickets de todos los usuarios, cambian estados, revisan indicadores y administran cuentas.
- Cada ticket conserva fecha y hora de creación en el servidor; el listado muestra el registro y el tiempo abierto actualizado, y al resolverse/cerrarse indica el tiempo estimado que permaneció abierto.
- Tickets y solicitudes cuentan con paginación de 25 registros por página; los tickets se pueden buscar y filtrar y la API admite `page` y `limit` (máximo 100).
- Seguimiento de tickets: TI puede asignar el responsable, conversar con el solicitante desde el historial público y documentar la causa raíz. El detalle muestra los cambios de estado, responsables, comentarios y adjuntos.
- Indicadores de tiempos: se mide el tiempo transcurrido hasta el primer comentario de TI y hasta la resolución/cierre, con promedios por semana, mes o historial completo; todavía no se aplican objetivos ni reglas de incumplimiento SLA.
- Adjuntos de tickets: se aceptan hasta 5 archivos PDF, JPG o PNG de hasta 10 MB cada uno. Se valida el contenido del archivo y se almacena en PostgreSQL; solo usuarios autorizados para consultar el ticket pueden descargarlos.
- Administración de usuarios: permite editar nombre, correo, rol y empresas; los administradores pueden establecer una nueva contraseña de al menos 12 caracteres, lo que invalida las sesiones activas de esa cuenta.
- Agenda: registra automáticamente el nombre y correo del solicitante; los administradores pueden confirmar o cancelar solicitudes.
- Actualización en vivo: los cambios de tickets, agenda, recursos y cuentas se reflejan en las sesiones abiertas mediante Server-Sent Events, sin recargar la página.
- Notificaciones persistentes: los administradores reciben avisos de nuevos tickets y citas; quien creó el ticket o la cita recibe un aviso cuando TI cambia su estado. La campana muestra los no leídos, permite marcarlos y reproduce un sonido configurable.
- Guías y soluciones: catálogo filtrable de enlaces a Google Drive; los administradores pueden crear, editar y archivar recursos, con imágenes de portada opcionales.
- Datos y sesiones en PostgreSQL, no en el almacenamiento del navegador.
- Validación en el servidor, contraseñas con bcrypt, sesiones con cookies `HttpOnly` y `SameSite=Strict`, token CSRF, verificación del origen, limitación de intentos de inicio de sesión y cabeceras de seguridad.
- Las solicitudes de agenda quedan pendientes hasta que TI confirme o cancele; no bloquean espacios ni crean eventos en Google Calendar.
- Interfaz adaptable a escritorio, tablet y móvil: navegación inferior táctil en pantallas pequeñas, tablas desplazables horizontalmente y formularios que se ajustan al ancho disponible.
- Modo oscuro opcional con preferencia guardada localmente por navegador; no cambia los datos ni la configuración de otros usuarios.

### Guías y soluciones en Google Drive

Desde **Guías y soluciones**, un administrador puede agregar y editar título, descripción, tipo, categoría, empresa y una URL HTTPS de `drive.google.com` o `docs.google.com`. Puede adjuntar una portada JPG, PNG o WebP de hasta 2 MB; la imagen se almacena en PostgreSQL junto al recurso y se entrega solo a usuarios con permiso para verlo. Los colaboradores ven recursos activos compartidos para todas las empresas o para cualquiera de las suyas; los administradores pueden archivar y reactivar recursos. Los enlaces abren en una pestaña nueva de Google Drive.

Los comentarios del ticket son visibles tanto para el solicitante como para TI. No incluyas contraseñas, tokens ni otra información que no deba compartirse con el solicitante. Los adjuntos también quedan disponibles para los usuarios que ya tienen acceso al ticket.

Compartir mediante enlace significa que cualquier persona que obtenga la URL podría abrir el archivo, según los permisos que se hayan configurado en Drive. No publiques contenido sensible ni contraseñas. Confirma los permisos del archivo antes de agregarlo; Nexo TI no valida quién puede abrir el recurso ni almacena el archivo de Drive, solo la imagen de portada opcional.

## Despliegue en EasyPanel

### 1. Preparar PostgreSQL

Crea una base de datos PostgreSQL en EasyPanel y guarda el usuario, contraseña, nombre de la base, host y puerto. Mantén el volumen persistente activado y establece un plan de respaldos; el volumen por sí solo no sustituye una copia de seguridad.

### 2. Crear el servicio de aplicación

Conecta este repositorio como servicio de aplicación, selecciona el constructor **Dockerfile** y deja que EasyPanel construya el archivo `Dockerfile` de la raíz. Asigna el dominio y configura el destino interno al mismo puerto indicado por la variable `PORT` (por defecto, **3000**). El protocolo del destino es HTTP; HTTPS termina en el proxy de EasyPanel.

Agrega estas variables al servicio:

| Variable | Valor |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` (o el puerto interno que elijas; el dominio debe apuntar al mismo) |
| `APP_ORIGIN` | Origen público exacto, por ejemplo `https://soporte.tudominio.com` (sin ruta ni `/` final) |
| `APP_TIMEZONE` | Zona IANA de la operación, por ejemplo `America/Mexico_City` |
| `DATABASE_URL` | `postgresql://USUARIO:CONTRASENA@HOST:PUERTO/BASE`; codifica en URL caracteres especiales de la contraseña |
| `SESSION_SECRET` | Secreto aleatorio de al menos 32 caracteres, distinto por instalación |

No uses los valores ficticios de `.env.example` en producción. Genera secretos criptográficamente seguros, guárdalos en el almacén de variables protegidas de EasyPanel y no los agregues al repositorio.

### 3. Crear la primera cuenta administradora

Antes del primer despliegue en una base vacía, define temporalmente:

- `BOOTSTRAP_ADMIN_NAME`
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD` (16 caracteres o más, aleatoria y exclusiva)

La aplicación crea esa cuenta únicamente cuando todavía no hay usuarios. Después de confirmar el inicio de sesión, elimina esas tres variables del servicio y reinicia. Las cuentas posteriores se crean desde **Usuarios**. Comparte sus contraseñas iniciales por un canal seguro.

### 4. Validar

Comprueba `https://tu-dominio/api/health`; debe responder `{"status":"ok"}`. Después, inicia sesión, crea un ticket y una solicitud de cita, prueba las notificaciones y el cambio de estado desde otra cuenta, vuelve a desplegar el contenedor y confirma que los datos permanecen. En EasyPanel, verifica asimismo el estado saludable del contenedor, la conexión a PostgreSQL, el HTTPS y la política de respaldo/restauración.

## Prueba local con Docker Compose

1. Copia `.env.example` a `.env`.
2. Cambia el dominio por `http://localhost:3000`.
3. Configura `POSTGRES_PASSWORD` con una contraseña hexadecimal generada, por ejemplo `openssl rand -hex 32`, y usa el mismo valor en `DATABASE_URL`; codifica por URL cualquier carácter especial.
4. Define `SESSION_SECRET` y `BOOTSTRAP_ADMIN_PASSWORD` con valores aleatorios seguros.
5. Ejecuta `docker compose up --build`.
6. Abre `http://localhost:3000`.

Compose conserva los datos PostgreSQL en el volumen `postgres_data`. No elimines ese volumen al reiniciar la aplicación.

## Límites conocidos y siguientes mejoras

- La agenda permite cambiar entre **Pendiente**, **Confirmada** y **Cancelada**. Hace falta implementar disponibilidad, prevención de conflictos y sincronización con Google Calendar.
- La integración con Google Calendar requiere credenciales OAuth autorizadas para el calendario compartido; no se conecta todavía.
- No se envían correos electrónicos. Los avisos siguen disponibles dentro del portal.
- Los tiempos de SLA son horas corridas, no descuentan horarios no laborables y no tienen umbrales de cumplimiento; además, los tiempos de primera respuesta solo se pueden medir desde que se habilita esta versión, porque los comentarios históricos no existían.
- El reporte general de frecuencias y los indicadores del resumen aún consumen las respuestas de compatibilidad limitadas a 500 tickets/solicitudes. Las tablas de tickets y agenda usan paginación y pueden recorrer el historial completo.
- No hay una política de retención automática configurada. La retención de tickets, comentarios, auditoría y archivos adjuntos debe definirse con el área responsable antes de aplicarla; eliminar adjuntos no se debe hacer sin una política aprobada.
- El selector de empresa modifica únicamente el alcance de visualización; cada ticket y cita se registra para una sola empresa seleccionada en su formulario.
- El sonido de notificaciones usa Web Audio y requiere una interacción previa con la página, conforme a las restricciones de reproducción automática del navegador. Si la sesión pierde temporalmente la conexión en vivo, el centro vuelve a sincronizar los avisos periódicamente.
- Las notificaciones se guardan por cuenta en PostgreSQL y el contador se comparte entre las sesiones abiertas de esa cuenta. Los avisos incluyen quién creó una cita nueva y el estado aplicado a tickets/citas.
- La auditoría de tickets es consultable desde el detalle y se conserva en PostgreSQL junto con los comentarios y adjuntos. Se recomienda revisar su retención y ejecutar periódicamente pruebas de restauración en una base separada.

### Respaldo y retención operacional

Los adjuntos se guardan como datos binarios en PostgreSQL, por lo que aumentan el tamaño de la base y forman parte de sus respaldos. Conserva el volumen persistente, automatiza copias con la plataforma y prueba la restauración en un servicio/base aislados antes de depender del respaldo. No borres ni trunques las tablas de tickets, comentarios, eventos o adjuntos como tarea de mantenimiento: acuerda y documenta primero el periodo de retención, las obligaciones internas y el procedimiento de restauración.

La app no elimina automáticamente tickets, notificaciones, eventos ni archivos. Los datos de primera respuesta anteriores a la instalación de esta versión no se reconstruyen; para ellos el promedio de primera respuesta no estará disponible.

En tickets que ya estaban **Resueltos** o **Cerrados**, el tiempo de resolución inicial se aproxima usando su último `updated_at` previo a esta migración; los tiempos nuevos se guardan al cambiar el estado.

## Pruebas

Ejecuta `npm test` para correr las pruebas unitarias y las pruebas HTTP de salud, autenticación y paginación. No requieren una base PostgreSQL; las pruebas de integración usan un pool y almacén de sesión en memoria.

## Datos y seguridad operacional

PostgreSQL contiene cuentas, asignaciones de empresas, tickets, solicitudes, cambios de estado y sesiones. Las migraciones iniciales crean las tablas e índices al arrancar; la migración de empresas múltiples conserva la empresa actual de cada colaborador. No publiques `DATABASE_URL`, `SESSION_SECRET` ni la contraseña temporal del administrador. Cualquier restauración debe probarse en un entorno separado antes de aplicarse a producción.
