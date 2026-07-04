# Dental Demo — Asistente Mía

Demo del asistente virtual para consultorio odontológico.

## Estructura

```
dental-demo/
├── backend/         Express + Claude API + Google Calendar
└── frontend/        HTML símil WhatsApp (archivo estático)
```

## Setup local

### 1. Credenciales de Google

1. Crear cuenta de Gmail nueva de test (ej. `consultorio.demo.test@gmail.com`)
2. En esa cuenta, ir a [Google Calendar](https://calendar.google.com) y crear dos calendarios:
   - "Dr. Pérez Demo"
   - "Dra. García Demo"
3. Ir a [Google Cloud Console](https://console.cloud.google.com):
   - Crear proyecto nuevo
   - Habilitar **Google Calendar API**
   - Ir a **IAM & Admin > Service Accounts** → Crear cuenta de servicio
   - Descargar el JSON de la cuenta de servicio
4. En Google Calendar, compartir cada calendario con el email de la cuenta de servicio (con permisos de edición)
5. Copiar el Calendar ID de cada calendario (Configuración del calendario > Integrar calendario)

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
# Editar .env con tus credenciales reales
npm run dev
```

El `.env` necesita:
- `ANTHROPIC_API_KEY` — de platform.anthropic.com
- `GOOGLE_SERVICE_ACCOUNT_JSON` — el contenido del JSON de la cuenta de servicio (en una sola línea)
- `CALENDAR_ID_DR_PEREZ` y `CALENDAR_ID_DRA_GARCIA` — los IDs de los calendarios

### 3. Frontend

Abrir `frontend/index.html` directamente en el browser.

> Antes de deployar a Render, cambiar `BACKEND_URL` en el HTML por la URL real de Render.

## Deploy (gratis)

### Backend → Render
1. Push del repo a GitHub (solo la carpeta `backend/`)
2. En [render.com](https://render.com), crear **New Web Service** desde el repo
3. Build command: `npm install`
4. Start command: `node index.js`
5. Agregar las variables de entorno en el dashboard de Render

### Frontend → Vercel
1. Push de `frontend/` a GitHub (puede ser el mismo repo)
2. En [vercel.com](https://vercel.com), importar el repo
3. Root directory: `frontend`
4. Antes del deploy, editar `BACKEND_URL` en el HTML con la URL de Render

## Personalización

- **Personalidad de Mía**: editar `SYSTEM_PROMPT` en `backend/agent.js`
- **Prácticas y reglas**: editar `KNOWLEDGE_BASE` en `backend/agent.js`
- **Horarios y profesionales**: editar `backend/calendar.js`

## Notas

- El historial de conversación vive en memoria (se pierde si el backend se reinicia). Para producción, migrar a PostgreSQL.
- El free tier de Render "duerme" tras 15 min de inactividad. El primer request tarda ~30s en despertar.
- Los logs de urgencias (`flag_critical_issue`) aparecen en la consola del backend. En producción, conectar con Twilio o WhatsApp API para notificar al doctor.
