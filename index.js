require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const bcrypt   = require("bcrypt");
const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const {
  checkAvailability, createAppointment, cancelAppointment,
  findPatientByIdentifier, getPatientAppointments,
} = require("./calendar");
const { google } = require("googleapis");
const { getSystemPrompt, TOOLS, config } = require("./agent");
const db = require("./db");

const app       = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET  = process.env.JWT_SECRET || "dental_demo_secret_cambiar_en_produccion";
const SALT_ROUNDS = 10;
// Mientras no haya multitenancy completa, el webhook (que llega sin JWT) asume este consultorio.
const DEFAULT_CONSULTORIO_ID = process.env.DEFAULT_CONSULTORIO_ID || 1;

// ─────────────────────────────────────────────
//  PERFIL DE INTEGRACIÓN ACTIVO
// ─────────────────────────────────────────────
// Devuelve el perfil con las credenciales descifradas, o null si no hay.
// Nunca tira: si falla, se loggea y el caller decide con qué seguir.
async function getPerfilActivo(consultorio_id = DEFAULT_CONSULTORIO_ID) {
  try {
    const perfil = await db.getActiveProfile(consultorio_id);
    if (!perfil) console.error(`[perfil] no hay perfil de integración activo para el consultorio ${consultorio_id}`);
    return perfil;
  } catch (err) {
    console.error("[perfil] error leyendo el perfil activo:", err.message);
    return null;
  }
}

// Credenciales de Google que espera calendar.js
function credsCalendar(perfil) {
  return {
    google_service_account_json: perfil?.google_service_account_json,
    calendar_id:                 perfil?.calendar_id,
  };
}

// ─────────────────────────────────────────────
//  VALIDACIÓN DE CREDENCIALES
// ─────────────────────────────────────────────
async function validarWhatsApp({ whatsapp_phone_number_id, whatsapp_token }) {
  if (!whatsapp_phone_number_id || !whatsapp_token) {
    return { ok: false, error: "Faltan el Phone Number ID o el token" };
  }
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(whatsapp_phone_number_id)}`,
      { headers: { Authorization: `Bearer ${whatsapp_token}` } }
    );
    if (resp.ok) return { ok: true, error: null };

    const texto = await resp.text().catch(() => "");
    let codigo = null;
    try { codigo = JSON.parse(texto)?.error?.code; } catch {}

    // Meta devuelve 401, pero también 400 con code 190, para un token vencido o inválido
    if (resp.status === 401 || codigo === 190) return { ok: false, error: "Token inválido" };
    if (resp.status === 404 || codigo === 803)  return { ok: false, error: "Phone Number ID no encontrado" };
    return { ok: false, error: `Meta respondió ${resp.status}${texto ? ": " + texto.slice(0, 160) : ""}` };
  } catch (err) {
    return { ok: false, error: `No se pudo conectar con Meta: ${err.message}` };
  }
}

async function validarCalendar({ google_service_account_json, calendar_id }) {
  if (!google_service_account_json || !calendar_id) {
    return { ok: false, error: "Faltan la Service Account o el Calendar ID" };
  }
  let credentials;
  try {
    credentials = JSON.parse(google_service_account_json);
  } catch {
    return { ok: false, error: "El JSON de la Service Account no es válido" };
  }
  if (!credentials.client_email || !credentials.private_key) {
    return { ok: false, error: "Al JSON le faltan client_email o private_key" };
  }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials, scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.events.list({ calendarId: calendar_id, maxResults: 1 });
    return { ok: true, error: null };
  } catch (err) {
    const msg    = err.message || "";
    const status = err.code || err.response?.status;
    if (msg.includes("invalid_grant")) return { ok: false, error: "Service account inválida" };
    if (status === 404) return { ok: false, error: "Calendar ID no encontrado o sin permisos" };
    if (status === 403) {
      return { ok: false, error: `Sin permisos sobre el calendario. ¿Lo compartiste con ${credentials.client_email}?` };
    }
    return { ok: false, error: msg.slice(0, 200) || "Error desconocido al validar el calendario" };
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
//  MIDDLEWARE DE AUTENTICACIÓN
// ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "No autorizado" });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}

// ─────────────────────────────────────────────
//  WHATSAPP — enviar mensaje
// ─────────────────────────────────────────────
function normalizarParaEnvioAR(numero) {
  if (numero && numero.startsWith("549") && numero.length === 13) return "54" + numero.slice(3);
  return numero;
}

async function sendWhatsAppMessage(to, text, perfil = null) {
  const p       = perfil || await getPerfilActivo();
  const token   = p?.whatsapp_token           || process.env.WHATSAPP_TOKEN;
  const phoneId = p?.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.error("[wa-send] no hay credenciales de WhatsApp: ni perfil activo ni env vars. Mensaje no enviado.");
    return;
  }
  const destinatario = normalizarParaEnvioAR(to);
  if (destinatario !== to) console.log(`[wa-send] normalizado AR: ${to} -> ${destinatario}`);
  const resp = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: destinatario, type: "text", text: { body: text } }),
  });
  const body = await resp.text();
  if (!resp.ok) console.error(`[wa-send] Meta respondió ${resp.status}:`, body);
  else console.log("[wa-send] OK:", body);
}

// ─────────────────────────────────────────────
//  CONTEXTO DEL PACIENTE PARA CLAUDE
// ─────────────────────────────────────────────
function buildPatientContext(patient) {
  const { nombre, dni, obra_social, telefono } = patient;
  const completo = nombre && dni && obra_social;
  if (completo) {
    return `[DATOS DEL PACIENTE]\nNombre: ${nombre}\nDNI: ${dni}\nObra social: ${obra_social}\nTeléfono: ${telefono}\nEstado: paciente existente — NO pedir estos datos nuevamente.`;
  }
  return `[DATOS DEL PACIENTE]\nNombre: ${nombre || "desconocido"}\nDNI: ${dni || "pendiente"}\nObra social: ${obra_social || "pendiente"}\nTeléfono: ${telefono}\nEstado: paciente nuevo — faltan datos. Pedirlos de a uno durante la conversación.`;
}

// ─────────────────────────────────────────────
//  EJECUTOR DE TOOLS
// ─────────────────────────────────────────────
async function executeTool(name, input, telefono, cfg = {}, perfil = null) {
  const creds = credsCalendar(perfil);
  console.log(`[tool] ${name}`, JSON.stringify(input, null, 2));
  const patient = await db.getPatient(telefono);
  switch (name) {
    case "check_availability": {
      // Los horarios del panel mandan sobre las franjas por defecto del calendario
      const slots = await checkAvailability({
        ...input,
        creds,
        horarios: {
          manana_desde: cfg.horario_manana_desde,
          manana_hasta: cfg.horario_manana_hasta,
          tarde_desde:  cfg.horario_tarde_desde,
          tarde_hasta:  cfg.horario_tarde_hasta,
        },
      });
      if (slots.length === 0) return { disponible: false, mensaje: "No encontré turnos libres en ese período." };
      return { disponible: true, slots };
    }
    case "create_appointment":
      return await createAppointment({
        ...input,
        creds,
        paciente_dni:         input.paciente_dni        || patient?.dni,
        paciente_obra_social: input.paciente_obra_social || patient?.obra_social,
        paciente_nombre:      input.paciente_nombre      || patient?.nombre,
        paciente_telefono:    input.paciente_telefono    || telefono,
      });
    case "cancel_appointment":
      return await cancelAppointment({ ...input, creds });
    case "get_patient_appointments": {
      const turnos = await getPatientAppointments(telefono, patient?.dni, creds);
      return { turnos };
    }
    case "save_patient_data": {
      const updated = await db.updatePatientData(telefono, {
        nombre: input.nombre || null, dni: input.dni || null, obra_social: input.obra_social || null,
      });
      console.log(`[paciente actualizado]`, updated);
      return { ok: true, guardado: updated };
    }
    case "flag_critical_issue": {
      console.error("🚨 URGENCIA DENTAL 🚨", input.paciente_nombre || patient?.nombre, telefono, input.descripcion);
      const doctorTel = process.env.WHATSAPP_DOCTOR_TELEFONO;
      if (doctorTel) await sendWhatsAppMessage(doctorTel, `URGENCIA — ${input.paciente_nombre || patient?.nombre || "Paciente"} (${telefono})\n${input.descripcion}`, perfil);
      return { ok: true, accion: `Alerta enviada al ${config.profesionales[0].nombre}. El paciente será contactado a la brevedad.` };
    }
    default: return { error: `Tool desconocida: ${name}` };
  }
}

// ─────────────────────────────────────────────
//  DELAY HUMANO
// ─────────────────────────────────────────────
function humanDelay(text) {
  const ms = Math.min(1200 + text.split(" ").length * 60, 3500);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
//  LOOP PRINCIPAL DEL AGENTE
//  Lee cfg y prácticas de DB en cada llamada
// ─────────────────────────────────────────────
async function runAgent(userMessage, telefono, consultorio_id = DEFAULT_CONSULTORIO_ID) {
  console.log(`[agent] mensaje entrante: "${userMessage.slice(0, 100)}"`);
  const patient = await db.getPatient(telefono);
  console.log(`[agent] paciente: ${patient ? `${patient.nombre||"sin nombre"} | dni=${patient.dni||"-"} | os=${patient.obra_social||"-"}` : "nuevo (sin datos)"}`);
  let claudeHistory = await db.getClaudeHistory(telefono);

  // El perfil del paciente viaja en el system prompt, que se arma en cada
  // mensaje. Las conversaciones viejas lo tienen clavado como primer mensaje
  // del historial, con el estado que el paciente tenía al arrancar: lo sacamos
  // para que no contradiga al perfil actualizado.
  if (typeof claudeHistory[0]?.content === "string" &&
      claudeHistory[0].content.startsWith("[DATOS DEL PACIENTE]")) {
    claudeHistory = claudeHistory.slice(2);
  }

  claudeHistory.push({ role: "user", content: userMessage });

  // Leer config y prácticas (solo las marcadas para_agente=true) de DB
  const [cfg, practicas, coberturas, perfil] = await Promise.all([
    db.getConfig(),
    db.getPracticas("agente"),
    db.getCoberturas(),
    getPerfilActivo(consultorio_id),
  ]);
  console.log(`[agent] usando ${practicas.length} prácticas del catálogo`);

  // Si el paciente pregunta sobre disponibilidad, forzamos check_availability
  // en vez de dejar que Claude responda de memoria basándose en la hora actual.
  const AVAILABILITY_RE = /\b(turno|turnos|lugar|disponib|horario|agendar|reservar|sacar turno|cuándo|cuando|esta tarde|esta mañana|hoy|libre|semana)\b/i;
  const forcearDisponibilidad = AVAILABILITY_RE.test(userMessage);
  const tool_choice = forcearDisponibilidad
    ? { type: "tool", name: "check_availability" }
    : { type: "auto" };
  if (forcearDisponibilidad) console.log("[agent] forzando check_availability por consulta de disponibilidad");

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5", max_tokens: 1024,
    system: getSystemPrompt(cfg, practicas, coberturas, buildPatientContext(patient)),
    tools: TOOLS, tool_choice, messages: claudeHistory,
  });

  console.log(`[agent] stop_reason=${response.stop_reason} | tools_called=${response.content.filter(b=>b.type==="tool_use").map(b=>b.name).join(",") || "ninguno"}`);

  while (response.stop_reason === "tool_use") {
    const toolResults = await Promise.all(
      response.content.filter(b => b.type === "tool_use").map(async block => ({
        type: "tool_result", tool_use_id: block.id,
        content: JSON.stringify(await executeTool(block.name, block.input, telefono, cfg, perfil)),
      }))
    );
    claudeHistory.push({ role: "assistant", content: response.content });
    claudeHistory.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 1024,
      // Se relee el paciente: si el agente acaba de guardar datos con
      // save_patient_data, el perfil ya refleja el estado nuevo.
      system: getSystemPrompt(cfg, practicas, coberturas, buildPatientContext(await db.getPatient(telefono) || patient)),
      tools: TOOLS, messages: claudeHistory,
    });
    console.log(`[agent] (loop) stop_reason=${response.stop_reason} | tools_called=${response.content.filter(b=>b.type==="tool_use").map(b=>b.name).join(",") || "ninguno"}`);
  }

  const finalText = response.content.find(b => b.type === "text")?.text || "No pude procesar eso.";
  console.log(`[agent] respuesta: "${finalText.slice(0, 200)}${finalText.length > 200 ? "…" : ""}`);
  claudeHistory.push({ role: "assistant", content: response.content });
  await db.saveClaudeHistory(telefono, claudeHistory);
  return finalText;
}

// ─────────────────────────────────────────────
//  AUTH ENDPOINTS
// ─────────────────────────────────────────────
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, nombre } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email y password requeridos" });
    if (password.length < 8) return res.status(400).json({ error: "El password debe tener al menos 8 caracteres" });
    if (!/\d/.test(password)) return res.status(400).json({ error: "El password debe tener al menos un número" });
    if (await db.getUserByEmail(email.toLowerCase())) return res.status(409).json({ error: "Ya existe un usuario con ese email" });
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await db.createUser({ email: email.toLowerCase(), password_hash, nombre });
    const token = jwt.sign({ userId: user.id, email: user.email, consultorio_id: user.consultorio_id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, email: user.email, nombre: user.nombre, consultorio_id: user.consultorio_id } });
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email y password requeridos" });
    const user = await db.getUserByEmail(email.toLowerCase());
    if (!user || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: "Email o password incorrecto" });
    const token = jwt.sign({ userId: user.id, email: user.email, consultorio_id: user.consultorio_id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, email: user.email, nombre: user.nombre, consultorio_id: user.consultorio_id } });
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

app.post("/auth/consultorio", authMiddleware, async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ error: "Nombre del consultorio requerido" });
    const consultorio = await db.createConsultorio(nombre);
    const user = await db.updateUserConsultorio(req.user.userId, consultorio.id);
    const token = jwt.sign({ userId: user.id, email: user.email, consultorio_id: consultorio.id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, consultorio, user: { id: user.id, email: user.email, nombre: user.nombre, consultorio_id: consultorio.id } });
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserByEmail(req.user.email);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
    const consultorio = user.consultorio_id ? await db.getConsultorio(user.consultorio_id) : null;
    res.json({ user: { id: user.id, email: user.email, nombre: user.nombre, descripcion: user.descripcion, consultorio_id: user.consultorio_id }, consultorio });
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

app.post("/auth/invitar", authMiddleware, async (req, res) => {
  try {
    if (!req.user.consultorio_id) return res.status(400).json({ error: "No tenés un consultorio asignado" });
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email requerido" });
    const token = crypto.randomBytes(32).toString("hex");
    await db.createInvitacion({ consultorio_id: req.user.consultorio_id, email: email.toLowerCase(), token });
    const link = `${process.env.APP_URL || "http://localhost:3000"}/register.html?token=${token}`;
    res.json({ ok: true, link, mensaje: `Compartí este link con ${email}` });
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

app.get("/auth/invitacion/:token", async (req, res) => {
  try {
    const inv = await db.getInvitacion(req.params.token);
    if (!inv) return res.status(400).json({ error: "Invitación inválida o expirada" });
    const consultorio = await db.getConsultorio(inv.consultorio_id);
    res.json({ email: inv.email, consultorio_nombre: consultorio?.nombre });
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

app.post("/auth/aceptar-invitacion", async (req, res) => {
  try {
    const { token, password, nombre } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token y password requeridos" });
    if (password.length < 8) return res.status(400).json({ error: "El password debe tener al menos 8 caracteres" });
    if (!/\d/.test(password)) return res.status(400).json({ error: "El password debe tener al menos un número" });
    const inv = await db.getInvitacion(token);
    if (!inv) return res.status(400).json({ error: "Invitación inválida o expirada" });
    const existe = await db.getUserByEmail(inv.email);
    if (existe) {
      await db.updateUserConsultorio(existe.id, inv.consultorio_id);
      await db.usarInvitacion(token);
      const jwtToken = jwt.sign({ userId: existe.id, email: existe.email, consultorio_id: inv.consultorio_id }, JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token: jwtToken, user: { id: existe.id, email: existe.email, nombre: existe.nombre, consultorio_id: inv.consultorio_id } });
    }
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await db.createUser({ email: inv.email, password_hash, nombre, consultorio_id: inv.consultorio_id });
    await db.usarInvitacion(token);
    const jwtToken = jwt.sign({ userId: user.id, email: user.email, consultorio_id: user.consultorio_id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token: jwtToken, user: { id: user.id, email: user.email, nombre: user.nombre, consultorio_id: user.consultorio_id } });
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

app.get("/admin/team", authMiddleware, async (req, res) => {
  try {
    if (!req.user.consultorio_id) return res.status(400).json({ error: "Sin consultorio asignado" });
    res.json(await db.getUsersByConsultorio(req.user.consultorio_id));
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

// ─────────────────────────────────────────────
//  WEBHOOK WHATSAPP
// ─────────────────────────────────────────────
app.get("/webhook", async (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  const perfil = await getPerfilActivo();
  const verifyToken = perfil?.whatsapp_verify_token || process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === "subscribe" && verifyToken && token === verifyToken) {
    console.log("[webhook] verificado por Meta");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== "text") return;
    const telefono = message.from, texto = message.text.body;
    console.log(`[whatsapp] mensaje de ${telefono}: ${texto}`);
    const perfil = await getPerfilActivo();
    let patient = await db.getPatient(telefono);
    if (!patient) {
      let datosPrevios = null;
      try {
        datosPrevios = await Promise.race([
          findPatientByIdentifier(telefono, null, credsCalendar(perfil)),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout Google Calendar (8s)")), 8000)),
        ]);
      } catch(e) { console.error("[wh] error/timeout Calendar:", e.message); }
      patient = await db.upsertPatient({ telefono, nombre: datosPrevios?.nombre || "Paciente", dni: datosPrevios?.dni || null, obra_social: datosPrevios?.obra_social || null, consultorio_id: DEFAULT_CONSULTORIO_ID });
    }
    await db.addMessage(telefono, "user", texto, new Date().toISOString());
    if (patient.modo === "humano") { console.log(`[whatsapp] conversación pausada para ${telefono}`); return; }
    const reply = await runAgent(texto, telefono);
    await humanDelay(reply);
    await db.addMessage(telefono, "assistant", reply, new Date().toISOString());
    await sendWhatsAppMessage(telefono, reply, perfil);
  } catch(err) { console.error("[webhook error]", err.message, err.stack); }
});

// ─────────────────────────────────────────────
//  ENDPOINTS WEB
// ─────────────────────────────────────────────
app.get("/session/:telefono", async (req, res) => {
  const { telefono } = req.params;
  const patient = await db.getPatient(telefono);
  if (patient) {
    return res.json({ existe: true, nombre: patient.nombre, dni: patient.dni, obra_social: patient.obra_social, displayHistory: await db.getMessages(telefono), fuente: "db" });
  }
  try {
    const encontrado = await findPatientByIdentifier(telefono, null, credsCalendar(await getPerfilActivo()));
    if (encontrado) return res.json({ existe: true, nombre: encontrado.nombre, dni: encontrado.dni, obra_social: encontrado.obra_social, displayHistory: [], fuente: "calendar" });
  } catch(err) { console.error("[calendar lookup error]", err.message); }
  res.json({ existe: false });
});

app.post("/session", async (req, res) => {
  const { telefono, nombre } = req.body;
  if (!telefono) return res.status(400).json({ error: "Falta el teléfono" });
  let patient = await db.getPatient(telefono);
  if (patient) {
    if (nombre && nombre !== patient.nombre) { await db.updatePatientData(telefono, { nombre }); patient = await db.getPatient(telefono); }
    return res.json({ nueva: false, nombre: patient.nombre, dni: patient.dni, obra_social: patient.obra_social, displayHistory: await db.getMessages(telefono) });
  }
  let datosPrevios = null;
  try { datosPrevios = await findPatientByIdentifier(telefono, null, credsCalendar(await getPerfilActivo())); } catch(err) {}
  patient = await db.upsertPatient({ telefono, nombre: datosPrevios?.nombre || nombre || "Paciente", dni: datosPrevios?.dni || null, obra_social: datosPrevios?.obra_social || null, consultorio_id: DEFAULT_CONSULTORIO_ID });
  res.json({ nueva: !datosPrevios, recuperado: !!datosPrevios, nombre: patient.nombre, dni: patient.dni, obra_social: patient.obra_social, displayHistory: [] });
});

app.post("/chat", async (req, res) => {
  const { mensaje, telefono } = req.body;
  if (!mensaje || !telefono) return res.status(400).json({ error: "Faltan campos: mensaje y telefono" });
  const patient = await db.getPatient(telefono);
  if (!patient) return res.status(404).json({ error: "Sesión no encontrada." });
  await db.addMessage(telefono, "user", mensaje, new Date().toISOString());
  if (patient.modo === "humano") return res.json({ reply: null, pausado: true });
  try {
    const reply = await runAgent(mensaje, telefono);
    await humanDelay(reply);
    const tsReply = new Date().toISOString();
    await db.addMessage(telefono, "assistant", reply, tsReply);
    res.json({ reply, ts: tsReply });
  } catch(err) { console.error("[error]", err); res.status(500).json({ error: "Error interno del agente" }); }
});

app.delete("/session/:telefono", async (req, res) => {
  await db.clearMessages(req.params.telefono);
  await db.clearClaudeHistory(req.params.telefono);
  res.json({ ok: true });
});

app.get("/patients",                    authMiddleware, async (req, res) => { res.json(await db.getAllPatients(consultorioDe(req))); });
app.get("/patients/:telefono/messages", authMiddleware, async (req, res) => { res.json(await db.getMessages(req.params.telefono)); });
app.post("/admin/pause/:telefono",      authMiddleware, async (req, res) => { await db.setPatientMode(req.params.telefono, "humano"); res.json({ ok: true }); });
app.post("/admin/resume/:telefono",     authMiddleware, async (req, res) => { await db.setPatientMode(req.params.telefono, "bot"); await db.clearClaudeHistory(req.params.telefono); res.json({ ok: true }); });

// Config
app.get("/config",  authMiddleware, async (req, res) => { res.json(await db.getConfig()); });
app.patch("/config", authMiddleware, async (req, res) => {
  const permitidos = ["horario_manana_desde","horario_manana_hasta","horario_tarde_desde","horario_tarde_hasta","estilo_conversacion","bot_whatsapp_number","cancelacion_anticipacion_hs","tolerancia_llegada_min","anticipacion_nuevo_min","palabras_alarma","flujo_paciente_nuevo","flujo_paciente_existente","mensaje_bienvenida","precio_consulta"];
  for (const [k, v] of Object.entries(req.body)) { if (permitidos.includes(k)) await db.setConfig(k, v); }
  res.json({ ok: true, config: await db.getConfig() });
});

// Prácticas — turno-directo ANTES de :id para que Express no confunda la ruta
app.get("/practicas",               authMiddleware, async (req, res) => { res.json(await db.getPracticas()); });
app.get("/practicas/turno-directo", authMiddleware, async (req, res) => { res.json(await db.getPracticas("turno_directo")); });
app.post("/practicas",              authMiddleware, async (req, res) => {
  try {
    const { nombre, duracion_min, precio, requiere, para_agente, para_turno_directo } = req.body;
    if (!nombre || !duracion_min) return res.status(400).json({ error: "nombre y duracion_min requeridos" });
    res.json(await db.createPractica({ nombre, duracion_min: parseInt(duracion_min), precio, requiere, para_agente, para_turno_directo }));
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});
app.patch("/practicas/:id", authMiddleware, async (req, res) => {
  try {
    console.log("[PATCH /practicas] id:", req.params.id, "body:", JSON.stringify(req.body));
    const campos = {};
    const b = req.body;
    if (b.nombre             !== undefined) campos.nombre             = b.nombre;
    if (b.duracion_min       !== undefined) campos.duracion_min       = parseInt(b.duracion_min);
    if (b.precio             !== undefined) campos.precio             = b.precio;
    if (b.requiere           !== undefined) campos.requiere           = b.requiere;
    if (b.para_agente        !== undefined) campos.para_agente        = b.para_agente;
    if (b.para_turno_directo !== undefined) campos.para_turno_directo = b.para_turno_directo;
    console.log("[PATCH /practicas] campos:", JSON.stringify(campos));
    const p = await db.updatePractica(req.params.id, campos);
    if (!p) return res.status(404).json({ error: "Práctica no encontrada" });
    res.json(p);
  } catch(err) { console.error("[PATCH /practicas] ERROR:", err.message); res.status(500).json({ error: "Error interno", detalle: err.message }); }
});
app.delete("/practicas/:id", authMiddleware, async (req, res) => {
  try { await db.deletePractica(req.params.id); res.json({ ok: true }); }
  catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

// Coberturas
app.get("/coberturas", authMiddleware, async (req, res) => {
  try { res.json(await db.getCoberturas()); }
  catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});
app.post("/coberturas", authMiddleware, async (req, res) => {
  try {
    const { obra_social, descuento_pct, primera_consulta_only } = req.body;
    if (!obra_social) return res.status(400).json({ error: "obra_social requerida" });
    res.json(await db.createCobertura({ obra_social, descuento_pct: parseInt(descuento_pct) || 0, primera_consulta_only }));
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});
app.patch("/coberturas/:id", authMiddleware, async (req, res) => {
  try {
    const campos = {};
    const b = req.body;
    if (b.obra_social           !== undefined) campos.obra_social           = b.obra_social;
    if (b.descuento_pct         !== undefined) campos.descuento_pct         = parseInt(b.descuento_pct);
    if (b.primera_consulta_only !== undefined) campos.primera_consulta_only = b.primera_consulta_only;
    const c = await db.updateCobertura(req.params.id, campos);
    if (!c) return res.status(404).json({ error: "Cobertura no encontrada" });
    res.json(c);
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});
app.delete("/coberturas/:id", authMiddleware, async (req, res) => {
  try { await db.deleteCobertura(req.params.id); res.json({ ok: true }); }
  catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});

// ─────────────────────────────────────────────
//  PERFILES DE INTEGRACIÓN
// ─────────────────────────────────────────────
function consultorioDe(req) {
  return req.user?.consultorio_id || DEFAULT_CONSULTORIO_ID;
}

// Valida un servicio individual sin guardar nada (para indicadores inline en el panel)
app.post("/profiles/validate-field", authMiddleware, async (req, res) => {
  try {
    const { service, ...creds } = req.body;
    if (service === "whatsapp") {
      res.json(await validarWhatsApp(creds));
    } else if (service === "calendar") {
      res.json(await validarCalendar(creds));
    } else {
      res.status(400).json({ ok: false, error: "Servicio no reconocido" });
    }
  } catch (err) {
    console.error("[POST /profiles/validate-field]", err.message);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// Valida credenciales sin guardar nada
app.post("/profiles/validate", authMiddleware, async (req, res) => {
  try {
    const [whatsapp, calendar] = await Promise.all([
      validarWhatsApp(req.body),
      validarCalendar(req.body),
    ]);
    res.json({ whatsapp, calendar });
  } catch (err) {
    console.error("[POST /profiles/validate]", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.get("/profiles", authMiddleware, async (req, res) => {
  try { res.json(await db.getProfiles(consultorioDe(req))); }
  catch (err) { console.error("[GET /profiles]", err.message); res.status(500).json({ error: "Error interno" }); }
});

// Devuelve las credenciales descifradas para mostrarlas y editarlas en el panel
app.get("/profiles/:id/credentials", authMiddleware, async (req, res) => {
  try {
    const p = await db.getProfileById(req.params.id);
    if (!p) return res.status(404).json({ error: "Perfil no encontrado" });
    res.json({
      whatsapp_phone_number_id:    p.whatsapp_phone_number_id    || "",
      whatsapp_token:              p.whatsapp_token              || "",
      whatsapp_verify_token:       p.whatsapp_verify_token       || "",
      google_service_account_json: p.google_service_account_json || "",
      calendar_id:                 p.calendar_id                 || "",
    });
  } catch (err) { console.error("[GET /profiles/credentials]", err.message); res.status(500).json({ error: "Error interno" }); }
});

// Re-valida un perfil usando las credenciales que tiene guardadas
app.post("/profiles/:id/validate", authMiddleware, async (req, res) => {
  try {
    const p = await db.getProfileById(req.params.id);
    if (!p) return res.status(404).json({ error: "Perfil no encontrado" });
    const [whatsapp, calendar] = await Promise.all([
      validarWhatsApp(p),
      validarCalendar(p),
    ]);
    res.json({ whatsapp, calendar });
  } catch (err) { console.error("[POST /profiles/:id/validate]", err.message); res.status(500).json({ error: "Error interno" }); }
});

app.post("/profiles", authMiddleware, async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: "El nombre del perfil es obligatorio" });

    const [whatsapp, calendar] = await Promise.all([
      validarWhatsApp(req.body),
      validarCalendar(req.body),
    ]);
    if (!whatsapp.ok || !calendar.ok) {
      return res.status(400).json({ error: "Las credenciales no son válidas", whatsapp, calendar });
    }

    const perfil = await db.createProfile({
      consultorio_id:              consultorioDe(req),
      nombre:                      nombre.trim(),
      activo:                      !!req.body.activo,
      whatsapp_phone_number_id:    req.body.whatsapp_phone_number_id,
      whatsapp_token:              req.body.whatsapp_token,
      whatsapp_verify_token:       req.body.whatsapp_verify_token,
      google_service_account_json: req.body.google_service_account_json,
      calendar_id:                 req.body.calendar_id,
    });
    res.json({ ok: true, perfil, whatsapp, calendar });
  } catch (err) {
    console.error("[POST /profiles]", err.message);
    res.status(500).json({ error: "Error interno", detalle: err.message });
  }
});

app.patch("/profiles/:id", authMiddleware, async (req, res) => {
  try {
    const actual = await db.getProfileById(req.params.id);
    if (!actual) return res.status(404).json({ error: "Perfil no encontrado" });

    const b = req.body;
    const campos = {};
    for (const c of ["nombre", "whatsapp_phone_number_id", "whatsapp_token",
                     "whatsapp_verify_token", "google_service_account_json", "calendar_id"]) {
      if (b[c] !== undefined) campos[c] = b[c];
    }
    if (!Object.keys(campos).length) return res.status(400).json({ error: "No hay nada para actualizar" });

    // Revalidar solo el bloque que cambió, usando los valores que ya están guardados
    // para los campos que el usuario no tocó.
    const merged = { ...actual, ...campos };
    const tocoWhatsapp = b.whatsapp_phone_number_id !== undefined || b.whatsapp_token !== undefined;
    const tocoCalendar = b.google_service_account_json !== undefined || b.calendar_id !== undefined;

    const whatsapp = tocoWhatsapp ? await validarWhatsApp(merged) : { ok: true, error: null, sinCambios: true };
    const calendar = tocoCalendar ? await validarCalendar(merged) : { ok: true, error: null, sinCambios: true };
    if (!whatsapp.ok || !calendar.ok) {
      return res.status(400).json({ error: "Las credenciales no son válidas", whatsapp, calendar });
    }

    const perfil = await db.updateProfile(req.params.id, campos);
    res.json({ ok: true, perfil, whatsapp, calendar });
  } catch (err) {
    console.error("[PATCH /profiles]", err.message);
    res.status(500).json({ error: "Error interno", detalle: err.message });
  }
});

app.post("/profiles/:id/activate", authMiddleware, async (req, res) => {
  try {
    const perfil = await db.activateProfile(req.params.id, consultorioDe(req));
    if (!perfil) return res.status(404).json({ error: "Perfil no encontrado" });
    console.log(`[perfil] activado "${perfil.nombre}" (id ${perfil.id})`);
    res.json({ ok: true, perfil });
  } catch (err) {
    console.error("[POST /profiles/activate]", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.delete("/profiles/:id", authMiddleware, async (req, res) => {
  try {
    const perfil = await db.getProfileById(req.params.id);
    if (!perfil) return res.status(404).json({ error: "Perfil no encontrado" });
    if (perfil.activo) {
      return res.status(400).json({ error: "No se puede eliminar el perfil activo. Activá otro primero." });
    }
    await db.deleteProfile(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /profiles]", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ─────────────────────────────────────────────
//  ARRANQUE
// ─────────────────────────────────────────────
db.initDB()
  .then(() => { const PORT = process.env.PORT || 3000; app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`)); })
  .catch((err) => { console.error("[db] Error al inicializar:", err); process.exit(1); });
