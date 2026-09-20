require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const {
  checkAvailability,
  createAppointment,
  cancelAppointment,
  findPatientByIdentifier,
  getPatientAppointments,
} = require("./calendar");
const { getSystemPrompt, TOOLS, config, ESTILOS } = require("./agent");
const db = require("./db");

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
//  WHATSAPP — enviar mensaje
// ─────────────────────────────────────────────
function normalizarParaEnvioAR(numero) {
  if (numero && numero.startsWith("549") && numero.length === 13) {
    return "54" + numero.slice(3);
  }
  return numero;
}

async function sendWhatsAppMessage(to, text) {
  const token   = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.error("[wa-send] falta WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID");
    return;
  }
  const destinatario = normalizarParaEnvioAR(to);
  if (destinatario !== to) console.log(`[wa-send] normalizado AR: ${to} -> ${destinatario}`);

  const resp = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: destinatario,
      type: "text",
      text: { body: text },
    }),
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
    return `[DATOS DEL PACIENTE]
Nombre: ${nombre}
DNI: ${dni}
Obra social: ${obra_social}
Teléfono: ${telefono}
Estado: paciente existente — NO pedir estos datos nuevamente.`;
  }
  return `[DATOS DEL PACIENTE]
Nombre: ${nombre || "desconocido"}
DNI: ${dni || "pendiente"}
Obra social: ${obra_social || "pendiente"}
Teléfono: ${telefono}
Estado: paciente nuevo — faltan datos. Pedirlos de a uno durante la conversación.`;
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
    case "create_appointment": {
      const inputEnriquecido = {
        ...input,
        paciente_dni:         input.paciente_dni        || patient?.dni,
        paciente_obra_social: input.paciente_obra_social || patient?.obra_social,
        paciente_nombre:      input.paciente_nombre      || patient?.nombre,
        paciente_telefono:    input.paciente_telefono    || telefono,
      };
      return await createAppointment(inputEnriquecido);
    }
    case "cancel_appointment":
      return await cancelAppointment(input);
    case "get_patient_appointments": {
      const turnos = await getPatientAppointments(telefono, patient?.dni);
      return { turnos };
    }
    case "save_patient_data": {
      const updated = await db.updatePatientData(telefono, {
        nombre:      input.nombre      || null,
        dni:         input.dni         || null,
        obra_social: input.obra_social || null,
      });
      console.log(`[paciente actualizado]`, updated);
      return { ok: true, guardado: updated };
    }
    case "flag_critical_issue": {
      console.error("🚨 URGENCIA DENTAL 🚨");
      console.error("Paciente:", input.paciente_nombre || patient?.nombre || "Desconocido");
      console.error("Teléfono:", telefono);
      console.error("Descripción:", input.descripcion);
      const doctorTel = process.env.WHATSAPP_DOCTOR_TELEFONO;
      if (doctorTel) {
        const msg = `URGENCIA — ${input.paciente_nombre || patient?.nombre || "Paciente"} (${telefono})\n${input.descripcion}`;
        await sendWhatsAppMessage(doctorTel, msg);
      }
      return { ok: true, accion: `Alerta enviada al ${config.profesionales[0].nombre}. El paciente será contactado a la brevedad.` };
    }
    default:
      return { error: `Tool desconocida: ${name}` };
  }
}

// ─────────────────────────────────────────────
//  DELAY HUMANO
// ─────────────────────────────────────────────
function humanDelay(text) {
  const palabras = text.split(" ").length;
  const ms = Math.min(1200 + palabras * 60, 3500);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
//  LOOP PRINCIPAL DEL AGENTE — con prompt caching
// ─────────────────────────────────────────────
async function runAgent(userMessage, telefono) {
  const patient = await db.getPatient(telefono);
  let claudeHistory = await db.getClaudeHistory(telefono);

  if (claudeHistory.length === 0) {
    claudeHistory.push({ role: "user", content: buildPatientContext(patient) });
    claudeHistory.push({ role: "assistant", content: "Entendido, tengo los datos del paciente." });
  }

  claudeHistory.push({ role: "user", content: userMessage });

  // ── Prompt caching: el system prompt y las tools se cachean ──
  // Reduce el costo de tokens de input hasta un 90% en conversaciones largas
  const systemWithCache = [
    {
      type: "text",
      text: getSystemPrompt(),
      cache_control: { type: "ephemeral" },
    },
  ];

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: systemWithCache,
    tools: TOOLS,
    messages: claudeHistory,
  });

  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await executeTool(block.name, block.input, telefono);
        return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
      })
    );

    claudeHistory.push({ role: "assistant", content: response.content });
    claudeHistory.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: systemWithCache,
      tools: TOOLS,
      messages: claudeHistory,
    });
  }

  const finalText = response.content.find((b) => b.type === "text")?.text || "No pude procesar eso.";
  claudeHistory.push({ role: "assistant", content: response.content });
  await db.saveClaudeHistory(telefono, claudeHistory);

  return finalText;
}

// ─────────────────────────────────────────────
//  WEBHOOK WHATSAPP
// ─────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[webhook] verificado por Meta");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry   = req.body?.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const telefono = message.from;
    const texto    = message.text.body;
    console.log(`[whatsapp] mensaje de ${telefono}: ${texto}`);

    // ── Detección de turno directo (generado desde el panel admin) ──
    // Formato: TURNO_DIRECTO|Nombre Paciente|Práctica|YYYY-MM-DD|HH:MM
    if (texto.startsWith("TURNO_DIRECTO|")) {
      const partes = texto.split("|");
      if (partes.length === 5) {
        const [, nombrePaciente, practica, fecha, hora] = partes;
        const fechaHora = `${fecha}T${hora}:00-03:00`;

        // Duraciones por práctica
        const duraciones = {
          "Control de rutina": 30, "Limpieza dental": 45,
          "Extracción simple": 60, "Blanqueamiento": 60,
          "Control de ortodoncia": 30, "Implante": 90,
        };
        const duracion = duraciones[practica] || 30;

        // Crear o retomar sesión del paciente
        let patient = await db.getPatient(telefono);
        if (!patient) {
          patient = await db.upsertPatient({ telefono, nombre: nombrePaciente, dni: null, obra_social: null });
        }
        await db.addMessage(telefono, "user", texto, new Date().toISOString());

        // Intentar crear el turno directamente
        const { createAppointment } = require("./calendar");
        const resultado = await createAppointment({
          paciente_nombre:      patient.nombre || nombrePaciente,
          paciente_telefono:    telefono,
          paciente_dni:         patient.dni,
          paciente_obra_social: patient.obra_social,
          fecha_hora:           fechaHora,
          tipo_practica:        practica,
          duracion_minutos:     duracion,
        });

        let reply;
        if (resultado.ok) {
          const fechaLegible = new Date(fechaHora).toLocaleString("es-AR", {
            weekday: "long", day: "numeric", month: "long",
            hour: "2-digit", minute: "2-digit",
            timeZone: "America/Argentina/Buenos_Aires",
          });
          reply = `Turno confirmado. Te esperamos el ${fechaLegible} para ${practica.toLowerCase()}. Si necesitas cancelar o cambiar el horario, avisanos con 24hs de anticipación.`;
        } else {
          reply = `El horario solicitado ya no está disponible. Pedile al doctor que te mande un nuevo link con otro horario libre.`;
        }

        await db.addMessage(telefono, "assistant", reply, new Date().toISOString());
        await sendWhatsAppMessage(telefono, reply);
        console.log("[wh] turno directo procesado");
        return;
      }
    }

    console.log("[wh] buscando paciente en db...");
    let patient = await db.getPatient(telefono);
    console.log("[wh] paciente db:", patient ? "encontrado" : "no encontrado");

    if (!patient) {
      let datosPrevios = null;
      console.log("[wh] consultando Google Calendar...");
      try {
        datosPrevios = await Promise.race([
          findPatientByIdentifier(telefono, null),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout Google Calendar (8s)")), 8000)),
        ]);
        console.log("[wh] respuesta de Calendar:", datosPrevios ? "encontrado" : "no encontrado");
      } catch (e) {
        console.error("[wh] error/timeout consultando Calendar:", e.message);
      }
      patient = await db.upsertPatient({
        telefono,
        nombre:      datosPrevios?.nombre      || "Paciente",
        dni:         datosPrevios?.dni         || null,
        obra_social: datosPrevios?.obra_social || null,
      });
      console.log("[wh] paciente creado en db");
    }

    await db.addMessage(telefono, "user", texto, new Date().toISOString());
    console.log("[wh] mensaje guardado");

    if (patient.modo === "humano") {
      console.log(`[whatsapp] conversación pausada para ${telefono}`);
      return;
    }

    console.log("[wh] llamando a runAgent...");
    const reply = await runAgent(texto, telefono);
    console.log("[wh] runAgent respondió:", reply?.slice(0, 80));

    await humanDelay(reply);
    await db.addMessage(telefono, "assistant", reply, new Date().toISOString());
    console.log("[wh] enviando por WhatsApp...");
    await sendWhatsAppMessage(telefono, reply);
    console.log("[wh] enviado OK");

  } catch (err) {
    console.error("[webhook error]", err.message, err.stack);
  }
});

// ─────────────────────────────────────────────
//  ENDPOINTS WEB (chat HTML)
// ─────────────────────────────────────────────
app.get("/session/:telefono", async (req, res) => {
  const { telefono } = req.params;
  const patient = await db.getPatient(telefono);
  if (patient) {
    const displayHistory = await db.getMessages(telefono);
    return res.json({ existe: true, nombre: patient.nombre, dni: patient.dni, obra_social: patient.obra_social, displayHistory, fuente: "db" });
  }
  try {
    const encontrado = await findPatientByIdentifier(telefono, null);
    if (encontrado) return res.json({ existe: true, nombre: encontrado.nombre, dni: encontrado.dni, obra_social: encontrado.obra_social, displayHistory: [], fuente: "calendar" });
  } catch (err) { console.error("[calendar lookup error]", err.message); }
  res.json({ existe: false });
});

app.post("/session", async (req, res) => {
  const { telefono, nombre } = req.body;
  if (!telefono) return res.status(400).json({ error: "Falta el teléfono" });
  let patient = await db.getPatient(telefono);
  if (patient) {
    if (nombre && nombre !== patient.nombre) { await db.updatePatientData(telefono, { nombre }); patient = await db.getPatient(telefono); }
    const displayHistory = await db.getMessages(telefono);
    return res.json({ nueva: false, nombre: patient.nombre, dni: patient.dni, obra_social: patient.obra_social, displayHistory });
  }
  let datosPrevios = null;
  try { datosPrevios = await findPatientByIdentifier(telefono, null); } catch (err) {}
  patient = await db.upsertPatient({ telefono, nombre: datosPrevios?.nombre || nombre || "Paciente", dni: datosPrevios?.dni || null, obra_social: datosPrevios?.obra_social || null });
  res.json({ nueva: !datosPrevios, recuperado: !!datosPrevios, nombre: patient.nombre, dni: patient.dni, obra_social: patient.obra_social, displayHistory: [] });
});

app.post("/chat", async (req, res) => {
  const { mensaje, telefono } = req.body;
  if (!mensaje || !telefono) return res.status(400).json({ error: "Faltan campos: mensaje y telefono" });
  const patient = await db.getPatient(telefono);
  if (!patient) return res.status(404).json({ error: "Sesión no encontrada." });
  const ahora = new Date().toISOString();
  await db.addMessage(telefono, "user", mensaje, ahora);
  if (patient.modo === "humano") return res.json({ reply: null, pausado: true });
  try {
    const reply = await runAgent(mensaje, telefono);
    await humanDelay(reply);
    const tsReply = new Date().toISOString();
    await db.addMessage(telefono, "assistant", reply, tsReply);
    res.json({ reply, ts: tsReply });
  } catch (err) {
    console.error("[error]", err);
    res.status(500).json({ error: "Error interno del agente" });
  }
});

app.delete("/session/:telefono", async (req, res) => {
  await db.clearMessages(req.params.telefono);
  await db.clearClaudeHistory(req.params.telefono);
  res.json({ ok: true });
});

app.get("/patients", async (req, res) => { res.json(await db.getAllPatients()); });
app.get("/patients/:telefono/messages", async (req, res) => { res.json(await db.getMessages(req.params.telefono)); });
app.post("/admin/pause/:telefono", async (req, res) => { await db.setPatientMode(req.params.telefono, "humano"); res.json({ ok: true }); });
app.post("/admin/resume/:telefono", async (req, res) => { await db.setPatientMode(req.params.telefono, "bot"); await db.clearClaudeHistory(req.params.telefono); res.json({ ok: true }); });
// GET /config — leer configuración del consultorio
app.get("/config", async (req, res) => {
  res.json(await db.getConfig());
});

// PATCH /config — actualizar uno o varios valores
app.patch("/config", async (req, res) => {
  const campos = req.body;
  const permitidos = ["horario_manana_desde","horario_manana_hasta","horario_tarde_desde","horario_tarde_hasta","estilo_conversacion","bot_whatsapp_number"];
  for (const [clave, valor] of Object.entries(campos)) {
    if (permitidos.includes(clave)) await db.setConfig(clave, valor);
  }
  res.json({ ok: true, config: await db.getConfig() });
});

// GET /config/estilos — lista de estilos disponibles
app.get("/config/estilos", (req, res) => {
  res.json(Object.entries(ESTILOS).map(([key, e]) => ({ key, label: e.label })));
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ─────────────────────────────────────────────
//  ARRANQUE
// ─────────────────────────────────────────────
db.initDB()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("[db] Error al inicializar:", err);
    process.exit(1);
  });
