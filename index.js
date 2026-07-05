require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const {
  checkAvailability,
  createAppointment,
  cancelAppointment,
  findPatientByIdentifier,
  getPatientAppointments,
} = require("./calendar");
const { getSystemPrompt, TOOLS } = require("./agent");

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());

// Servir el frontend desde la carpeta ./public
const path = require("path");
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
//  STORE EN MEMORIA
//  Si el backend se reinicia, se reconstruye
//  desde Google Calendar en POST /session
// ─────────────────────────────────────────────
const patients = {};

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
  const patient = patients[telefono];

  switch (name) {
    case "check_availability": {
      const slots = await checkAvailability(input);
      if (slots.length === 0) {
        return { disponible: false, mensaje: "No encontré turnos libres en ese período." };
      }
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
      const result = await createAppointment(inputEnriquecido);
      if (!result.ok) {
        // Devolver el error para que Claude lo comunique y busque otro horario
        return result;
      }
      return result;
    }

    case "cancel_appointment": {
      return await cancelAppointment(input);
    }

    case "get_patient_appointments": {
      const turnos = await getPatientAppointments(telefono, patient?.dni);
      return { turnos };
    }

    case "save_patient_data": {
      if (input.nombre)      patient.nombre      = input.nombre;
      if (input.dni)         patient.dni         = input.dni;
      if (input.obra_social) patient.obra_social = input.obra_social;

      console.log(`[paciente actualizado] ${telefono}`, {
        nombre: patient.nombre,
        dni: patient.dni,
        obra_social: patient.obra_social,
      });

      return {
        ok: true,
        guardado: {
          nombre: patient.nombre,
          dni: patient.dni,
          obra_social: patient.obra_social,
        },
      };
    }

    case "flag_critical_issue": {
      console.error("🚨 URGENCIA DENTAL 🚨");
      console.error("Paciente:", input.paciente_nombre || patient?.nombre || "Desconocido");
      console.error("Teléfono:", telefono);
      console.error("Descripción:", input.descripcion);
      return {
        ok: true,
        accion: "Alerta enviada al Dr. Diego. El paciente será contactado a la brevedad.",
      };
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
//  LOOP PRINCIPAL DEL AGENTE
// ─────────────────────────────────────────────
async function runAgent(userMessage, telefono) {
  const patient = patients[telefono];

  if (patient.claudeHistory.length === 0) {
    patient.claudeHistory.push({
      role: "user",
      content: buildPatientContext(patient),
    });
    patient.claudeHistory.push({
      role: "assistant",
      content: "Entendido, tengo los datos del paciente.",
    });
  }

  patient.claudeHistory.push({ role: "user", content: userMessage });

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: getSystemPrompt(),
    tools: TOOLS,
    messages: patient.claudeHistory,
  });

  while (response.stop_reason === "tool_use") {
    // Claude puede pedir múltiples tools en paralelo — procesarlas todas
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await executeTool(block.name, block.input, telefono);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      })
    );

    patient.claudeHistory.push({ role: "assistant", content: response.content });
    patient.claudeHistory.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages: patient.claudeHistory,
    });
  }

  const finalText = response.content.find((b) => b.type === "text")?.text || "No pude procesar eso.";
  patient.claudeHistory.push({ role: "assistant", content: response.content });

  return finalText;
}

// ─────────────────────────────────────────────
//  ENDPOINTS
// ─────────────────────────────────────────────

// GET /session/:telefono
// Chequea memoria primero, luego busca en Google Calendar
app.get("/session/:telefono", async (req, res) => {
  const { telefono } = req.params;

  // 1. Buscar en memoria
  if (patients[telefono]) {
    const p = patients[telefono];
    return res.json({
      existe: true,
      nombre: p.nombre,
      dni: p.dni,
      obra_social: p.obra_social,
      displayHistory: p.displayHistory,
      fuente: "memoria",
    });
  }

  // 2. Si no está en memoria, buscar en Google Calendar
  try {
    const encontrado = await findPatientByIdentifier(telefono, null);
    if (encontrado) {
      console.log(`[calendar lookup] paciente encontrado por teléfono: ${telefono}`, encontrado);
      return res.json({
        existe: true,
        nombre: encontrado.nombre,
        dni: encontrado.dni,
        obra_social: encontrado.obra_social,
        displayHistory: [],
        fuente: "calendar",
      });
    }
  } catch (err) {
    console.error("[calendar lookup error]", err.message);
  }

  res.json({ existe: false });
});

// POST /session — crear o retomar sesión
app.post("/session", async (req, res) => {
  const { telefono, nombre } = req.body;

  if (!telefono) return res.status(400).json({ error: "Falta el teléfono" });

  // Ya existe en memoria
  if (patients[telefono]) {
    if (nombre) patients[telefono].nombre = nombre;
    const p = patients[telefono];
    return res.json({
      nueva: false,
      nombre: p.nombre,
      dni: p.dni,
      obra_social: p.obra_social,
      displayHistory: p.displayHistory,
    });
  }

  // Buscar en Google Calendar (backend reiniciado)
  let datosPrevios = null;
  try {
    datosPrevios = await findPatientByIdentifier(telefono, null);
    if (datosPrevios) {
      console.log(`[sesión recuperada desde calendar] ${telefono}`, datosPrevios);
    }
  } catch (err) {
    console.error("[calendar lookup error]", err.message);
  }

  // Crear entrada en memoria (con datos recuperados o vacía)
  patients[telefono] = {
    telefono,
    nombre: datosPrevios?.nombre || nombre || "Paciente",
    dni: datosPrevios?.dni || null,
    obra_social: datosPrevios?.obra_social || null,
    claudeHistory: [],
    displayHistory: [],
  };

  const p = patients[telefono];
  const esNuevo = !datosPrevios;

  res.json({
    nueva: esNuevo,
    recuperado: !!datosPrevios,
    nombre: p.nombre,
    dni: p.dni,
    obra_social: p.obra_social,
    displayHistory: [],
  });
});

// POST /chat
app.post("/chat", async (req, res) => {
  const { mensaje, telefono } = req.body;

  if (!mensaje || !telefono) {
    return res.status(400).json({ error: "Faltan campos: mensaje y telefono" });
  }

  if (!patients[telefono]) {
    return res.status(404).json({ error: "Sesión no encontrada. Llamá a POST /session primero." });
  }

  const patient = patients[telefono];
  const ahora = new Date().toISOString();
  patient.displayHistory.push({ role: "user", text: mensaje, ts: ahora });

  try {
    const reply = await runAgent(mensaje, telefono);
    await humanDelay(reply);

    const tsReply = new Date().toISOString();
    patient.displayHistory.push({ role: "assistant", text: reply, ts: tsReply });

    res.json({ reply, ts: tsReply });
  } catch (err) {
    console.error("[error]", err);
    res.status(500).json({ error: "Error interno del agente" });
  }
});

// DELETE /session/:telefono — borrar historial, mantener datos del paciente
app.delete("/session/:telefono", (req, res) => {
  const { telefono } = req.params;
  if (patients[telefono]) {
    patients[telefono].claudeHistory = [];
    patients[telefono].displayHistory = [];
  }
  res.json({ ok: true });
});

// GET /patients — ver todos los pacientes (debug)
app.get("/patients", (req, res) => {
  const resumen = Object.values(patients).map((p) => ({
    telefono: p.telefono,
    nombre: p.nombre,
    dni: p.dni,
    obra_social: p.obra_social,
    mensajes: p.displayHistory.length,
  }));
  res.json(resumen);
});

// Health check
app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`));