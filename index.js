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
const { getSystemPrompt, TOOLS, config } = require("./agent");
const db = require("./db");

const app       = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET  = process.env.JWT_SECRET || "dental_demo_secret_cambiar_en_produccion";
const SALT_ROUNDS = 10;

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

async function sendWhatsAppMessage(to, text) {
  const token   = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) { console.error("[wa-send] falta WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID"); return; }
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
async function executeTool(name, input, telefono) {
  console.log(`[tool] ${name}`, JSON.stringify(input, null, 2));
  const patient = await db.getPatient(telefono);
  switch (name) {
    case "check_availability": {
      const slots = await checkAvailability(input);
      if (slots.length === 0) return { disponible: false, mensaje: "No encontré turnos libres en ese período." };
      return { disponible: true, slots };
    }
    case "create_appointment":
      return await createAppointment({
        ...input,
        paciente_dni:         input.paciente_dni        || patient?.dni,
        paciente_obra_social: input.paciente_obra_social || patient?.obra_social,
        paciente_nombre:      input.paciente_nombre      || patient?.nombre,
        paciente_telefono:    input.paciente_telefono    || telefono,
      });
    case "cancel_appointment":
      return await cancelAppointment(input);
    case "get_patient_appointments": {
      const turnos = await getPatientAppointments(telefono, patient?.dni);
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
      if (doctorTel) await sendWhatsAppMessage(doctorTel, `URGENCIA — ${input.paciente_nombre || patient?.nombre || "Paciente"} (${telefono})\n${input.descripcion}`);
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
async function runAgent(userMessage, telefono) {
  const patient = await db.getPatient(telefono);
  let claudeHistory = await db.getClaudeHistory(telefono);
  if (claudeHistory.length === 0) {
    claudeHistory.push({ role: "user", content: buildPatientContext(patient) });
    claudeHistory.push({ role: "assistant", content: "Entendido, tengo los datos del paciente." });
  }
  claudeHistory.push({ role: "user", content: userMessage });

  // Leer config y prácticas (solo las marcadas para_agente=true) de DB
  const [cfg, practicas] = await Promise.all([
    db.getConfig(),
    db.getPracticas("agente"),
  ]);
  console.log(`[agent] usando ${practicas.length} prácticas del catálogo`);

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5", max_tokens: 1024,
    system: getSystemPrompt(cfg, practicas),
    tools: TOOLS, messages: claudeHistory,
  });

  while (response.stop_reason === "tool_use") {
    const toolResults = await Promise.all(
      response.content.filter(b => b.type === "tool_use").map(async block => ({
        type: "tool_result", tool_use_id: block.id,
        content: JSON.stringify(await executeTool(block.name, block.input, telefono)),
      }))
    );
    claudeHistory.push({ role: "assistant", content: response.content });
    claudeHistory.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 1024,
      system: getSystemPrompt(cfg, practicas),
      tools: TOOLS, messages: claudeHistory,
    });
  }

  const finalText = response.content.find(b => b.type === "text")?.text || "No pude procesar eso.";
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
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
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
    let patient = await db.getPatient(telefono);
    if (!patient) {
      let datosPrevios = null;
      try {
        datosPrevios = await Promise.race([
          findPatientByIdentifier(telefono, null),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout Google Calendar (8s)")), 8000)),
        ]);
      } catch(e) { console.error("[wh] error/timeout Calendar:", e.message); }
      patient = await db.upsertPatient({ telefono, nombre: datosPrevios?.nombre || "Paciente", dni: datosPrevios?.dni || null, obra_social: datosPrevios?.obra_social || null });
    }
    await db.addMessage(telefono, "user", texto, new Date().toISOString());
    if (patient.modo === "humano") { console.log(`[whatsapp] conversación pausada para ${telefono}`); return; }
    const reply = await runAgent(texto, telefono);
    await humanDelay(reply);
    await db.addMessage(telefono, "assistant", reply, new Date().toISOString());
    await sendWhatsAppMessage(telefono, reply);
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
    const encontrado = await findPatientByIdentifier(telefono, null);
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
  try { datosPrevios = await findPatientByIdentifier(telefono, null); } catch(err) {}
  patient = await db.upsertPatient({ telefono, nombre: datosPrevios?.nombre || nombre || "Paciente", dni: datosPrevios?.dni || null, obra_social: datosPrevios?.obra_social || null });
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

app.get("/patients",                    authMiddleware, async (req, res) => { res.json(await db.getAllPatients()); });
app.get("/patients/:telefono/messages", authMiddleware, async (req, res) => { res.json(await db.getMessages(req.params.telefono)); });
app.post("/admin/pause/:telefono",      authMiddleware, async (req, res) => { await db.setPatientMode(req.params.telefono, "humano"); res.json({ ok: true }); });
app.post("/admin/resume/:telefono",     authMiddleware, async (req, res) => { await db.setPatientMode(req.params.telefono, "bot"); await db.clearClaudeHistory(req.params.telefono); res.json({ ok: true }); });

// Config
app.get("/config",  authMiddleware, async (req, res) => { res.json(await db.getConfig()); });
app.patch("/config", authMiddleware, async (req, res) => {
  const permitidos = ["horario_manana_desde","horario_manana_hasta","horario_tarde_desde","horario_tarde_hasta","estilo_conversacion","bot_whatsapp_number"];
  for (const [k, v] of Object.entries(req.body)) { if (permitidos.includes(k)) await db.setConfig(k, v); }
  res.json({ ok: true, config: await db.getConfig() });
});

// Prácticas — turno-directo ANTES de :id para que Express no confunda la ruta
app.get("/practicas",               authMiddleware, async (req, res) => { res.json(await db.getPracticas()); });
app.get("/practicas/turno-directo", authMiddleware, async (req, res) => { res.json(await db.getPracticas("turno_directo")); });
app.post("/practicas",              authMiddleware, async (req, res) => {
  try {
    const { nombre, duracion_min, requiere, para_agente, para_turno_directo } = req.body;
    if (!nombre || !duracion_min) return res.status(400).json({ error: "nombre y duracion_min requeridos" });
    res.json(await db.createPractica({ nombre, duracion_min: parseInt(duracion_min), requiere, para_agente, para_turno_directo }));
  } catch(err) { console.error(err); res.status(500).json({ error: "Error interno" }); }
});
app.patch("/practicas/:id", authMiddleware, async (req, res) => {
  try {
    console.log("[PATCH /practicas] id:", req.params.id, "body:", JSON.stringify(req.body));
    const campos = {};
    const b = req.body;
    if (b.nombre             !== undefined) campos.nombre             = b.nombre;
    if (b.duracion_min       !== undefined) campos.duracion_min       = parseInt(b.duracion_min);
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

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ─────────────────────────────────────────────
//  ARRANQUE
// ─────────────────────────────────────────────
db.initDB()
  .then(() => { const PORT = process.env.PORT || 3000; app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`)); })
  .catch((err) => { console.error("[db] Error al inicializar:", err); process.exit(1); });
