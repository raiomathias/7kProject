# The 7K Project

Aplicación privada mobile-first para **Lukas, Vicente y Mathias**: objetivo compartido de 7 km, registro de corridas, estadísticas individuales y de equipo, historial, evidencia fotográfica y actualizaciones en tiempo real. Mathias es el único administrador.

## Stack
- React 18 + Vite 6.
- Supabase Postgres, Storage y Edge Functions.
- Autenticación propia (sin Supabase Auth): PBKDF2-SHA256 con salt aleatorio, sesiones opacas aleatorias revocables y autorización validada en servidor.
- Realtime Broadcast notifica cambios sin exponer datos de las tablas.
- Esquema `public` con RLS activo y acceso API directo revocado para `anon` y `authenticated`. Solo Edge Function con clave de servidor opera las tablas.

## Inicialización del proyecto
1. En Supabase Dashboard abre **Edge Functions → Secrets**.
2. Crea `BOOTSTRAP_SECRET` con un secreto aleatorio de al menos 32 caracteres. No uses la publishable key ni una contraseña de integrante.
3. Abre `bootstrap.html` desde el sitio del proyecto (o localmente) y define tres contraseñas únicas de al menos 10 caracteres. Mathias queda como admin, Lukas y Vicente como integrantes.
4. Inicia la aplicación con `npm install` y `npm run dev`, o publica el contenido con un hosting estático compatible.
5. La pantalla de configuración inicial solo funciona mientras no exista ningún usuario; una vez creadas las cuentas, el endpoint queda cerrado.

## Desarrollo
```bash
cp .env.example .env.local
npm install
npm run dev
```
La publishable key de este proyecto ya está configurada como valor público de respaldo en el cliente. No agregues nunca claves secret/service-role al frontend.

## Imágenes
Las imágenes se convierten en el navegador a WebP, se redimensionan a 1920 px para evidencias y 640 px para avatares y se comprimen con calidad ajustada. Se rechazan originales mayores a 18 MB y resultados mayores a 5 MB. Storage es privado, acepta solo WebP y limita cada objeto a 8 MB. Las lecturas se entregan mediante URLs firmadas temporales.

## Funcionalidades
- Resumen del equipo, distancia acumulada, objetivo configurable y avance individual.
- Registro de distancia, tiempo, ritmo calculado, dificultad, fecha, notas y dos evidencias.
- Historial filtrable por integrante.
- Tarjetas de Lukas, Vicente y Mathias, ranking por distancia acumulada, mejor marca y sesiones.
- Rachas de días entrenados, ritmo promedio y mejor ritmo individual.
- Gráficos de distancia acumulada y evolución del ritmo.
- Cuenta regresiva a la fecha objetivo.
- Proyección estimada a la meta según ritmo de la sesión.
- Foto de perfil y evidencias de Strava/fotos con compresión automática; miniaturas con enlaces privados temporales.
- Mathias puede cambiar meta, fecha límite, banner y fotos de los integrantes.
- Realtime Broadcast para refrescar el panel, con polling de respaldo.

## Seguridad
- No se almacenan contraseñas en texto plano.
- El token de sesión se guarda en `sessionStorage`, nunca el objeto usuario ni el rol.
- El servidor valida la sesión en cada petición y comprueba rol admin en las operaciones administrativas.
- Los hashes de sesión se almacenan en la base de datos; se pueden revocar al cerrar sesión o desactivar un usuario.
- No se concede acceso directo a tablas ni bucket a los roles públicos.
- `BOOTSTRAP_SECRET` solo debe existir en los secretos de Edge Functions.
