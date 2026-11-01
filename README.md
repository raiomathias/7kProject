# The 7K Project
App privada mobile-first para Lukas, Vicente y Mathias.

## Stack
React + Vite, Supabase Postgres, Storage y Edge Functions.

## Seguridad
Autenticación propia con PBKDF2-SHA256, sesiones aleatorias revocables, verificación server-side y esquema privado app sin acceso directo desde anon/authenticated. La clave service-role permanece solo en Edge Functions.

## Imágenes
El navegador convierte imágenes a WebP, reduce dimensiones (1920 px para evidencias y 640 px para avatares) y ajusta calidad antes de subir al bucket privado 7k-media.

## Configuración
Copia .env.example a .env.local y define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY. Configura BOOTSTRAP_SECRET en los secretos de Edge Functions (mínimo 32 caracteres) antes de crear las tres cuentas iniciales mediante /functions/v1/api/bootstrap.