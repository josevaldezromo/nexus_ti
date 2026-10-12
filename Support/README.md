# Nexo TI

**Conectamos soluciones.** Nexo TI es el portal interno de soporte para Bormine, Didiamant y Corpdiam. La aplicación utiliza Node.js, PostgreSQL y sesiones protegidas por cookie. Está preparada para ejecutarse como contenedor en EasyPanel.

## Funciones implementadas

- Inicio de sesión con cuentas creadas por un administrador; no hay registro público.
- Cambio de contraseña personal; al cambiarla se invalidan las otras sesiones.
- Acceso de administrador o colaborador asociado a una empresa.
- Colaboradores: crean citas y tickets; solo consultan sus propios registros.
- Administradores: consultan tickets de todos los usuarios, cambian estados, revisan indicadores y administran cuentas.
- Datos y sesiones en PostgreSQL, no en el almacenamiento del navegador.
- Validación en el servidor, contraseñas con bcrypt, sesiones con cookies `HttpOnly` y `SameSite=Strict`, token CSRF, verificación del origen, limitación de intentos de inicio de sesión y cabeceras de seguridad.
- Solicitudes de agenda sujetas a confirmación. Todavía no bloquean espacios ni crean eventos en Google Calendar.

## Despliegue en EasyPanel

### 1. Preparar PostgreSQL

Crea una base de datos PostgreSQL en EasyPanel y guarda el usuario, contraseña, nombre de la base, host y puerto. Mantén el volumen persistente activado y establece un plan de respaldos; el volumen por sí solo no sustituye una copia de seguridad.

### 2. Crear el servicio de aplicación

Conecta este repositorio como servicio de aplicación, selecciona el constructor **Dockerfile** y deja que EasyPanel construya el archivo `Dockerfile` de la raíz. Asigna el dominio y configura el destino interno al puerto **3000**. Habilita HTTPS.

Agrega estas variables al servicio:

| Variable | Valor |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
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

Comprueba `https://tu-dominio/api/health`; debe responder `{"status":"ok"}`. Después, inicia sesión, crea un ticket y una solicitud de cita, vuelve a desplegar el contenedor y confirma que los datos permanecen. En EasyPanel, verifica asimismo el estado saludable del contenedor, la conexión a PostgreSQL, el HTTPS y la política de respaldo/restauración.

## Prueba local con Docker Compose

1. Copia `.env.example` a `.env`.
2. Cambia el dominio por `http://localhost:3000`.
3. Configura `POSTGRES_PASSWORD` con una contraseña hexadecimal generada, por ejemplo `openssl rand -hex 32`, y usa el mismo valor en `DATABASE_URL`; codifica por URL cualquier carácter especial.
4. Define `SESSION_SECRET` y `BOOTSTRAP_ADMIN_PASSWORD` con valores aleatorios seguros.
5. Ejecuta `docker compose up --build`.
6. Abre `http://localhost:3000`.

Compose conserva los datos PostgreSQL en el volumen `postgres_data`. No elimines ese volumen al reiniciar la aplicación.

## Límites conocidos y siguiente fase

- Las citas se registran como **Pendiente**; hace falta implementar disponibilidad, confirmación, prevención de conflictos y cancelación.
- La integración con Google Calendar requiere credenciales OAuth autorizadas para el calendario compartido; no se conecta todavía.
- No se envían correos/notificaciones y no se adjuntan archivos.
- El reporte calcula frecuencias a partir de los registros disponibles. Para SLA/causa raíz hacen falta campos de asignación, tiempos de primera respuesta y resolución, causa raíz y auditoría visible.
- Las solicitudes y tickets no tienen paginación de interfaz; la API limita respuestas a 500 registros.
- Se recomienda añadir políticas de retención, auditoría consultable, respaldos probados y más pruebas de integración antes de abrir el servicio a toda la empresa.

## Datos y seguridad operacional

PostgreSQL contiene cuentas, tickets, solicitudes, cambios de estado y sesiones. Las migraciones iniciales crean las tablas e índices al arrancar. No publiques `DATABASE_URL`, `SESSION_SECRET` ni la contraseña temporal del administrador. Cualquier restauración debe probarse en un entorno separado antes de aplicarse a producción.
 al final hice una prueba de git desktop
 Clone de github desktop