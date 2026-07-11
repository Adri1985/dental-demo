const path = require("path");
const config = require(path.join(__dirname, "config/consultorio.json"));

// ─────────────────────────────────────────────
//  Helpers para construir texto desde el config
// ─────────────────────────────────────────────

function buildPracticasText() {
  return config.practicas.map(p => {
    let texto = `- ${p.nombre}: ${p.duracion} minutos`;
    if (p.requiere && p.requiere.length > 0) {
      texto += `\n  → REQUIERE: ${p.requiere.join("\n  → REQUIERE: ")}`;
    }
    return texto;
  }).join("\n");
}

function buildHorariosText() {
  return config.profesionales.map(p => {
    const h = p.horarios;
    return `- ${p.nombre}: ${h.dias} de ${h.manana.desde} a ${h.manana.hasta} y ${h.tarde.desde} a ${h.tarde.hasta} (último turno a las ${h.tarde.ultimo_turno})`;
  }).join("\n");
}

function buildProfesionalesEnum() {
  return config.profesionales.map(p => p.id);
}

function buildKnowledgeBase() {
  const precio = config.precio_consulta.toLocaleString("es-AR");
  const pol = config.politica;

  return `
CONSULTORIO:
- Nombre: ${config.consultorio.nombre}
${config.consultorio.direccion ? `- Dirección: ${config.consultorio.direccion}` : ""}

PROFESIONALES Y HORARIOS:
${buildHorariosText()}

VALOR DE CONSULTA:
- Consulta estándar: $${precio} pesos
- Si el paciente pregunta el precio, informá este valor
- Tras informar el valor, preguntar si está de acuerdo para continuar con el turno

TIPOS DE TURNO:
- Paciente nuevo: turno de 30 minutos por defecto, salvo que el profesional indique otro tiempo
- Paciente existente: turno de 30 minutos por defecto, salvo que el profesional indique otro tiempo

PRÁCTICAS DISPONIBLES:
${buildPracticasText()}

FLUJO PARA PACIENTE NUEVO:
1. Saludar de forma breve
2. Pedir: nombre completo, DNI y obra social (de a uno, nunca todos juntos)
3. Informar el valor de la consulta ($${precio})
4. Si acepta, buscar disponibilidad y asignar turno
5. Confirmar el turno con todos los datos

FLUJO PARA PACIENTE EXISTENTE:
1. Saludar por su nombre (ya lo tenés guardado)
2. Preguntar qué necesita
3. Buscar disponibilidad y asignar turno
4. Confirmar

POLÍTICA DE TURNOS:
- Cancelaciones: avisar con al menos ${pol.cancelacion_anticipacion_hs} horas de anticipación
- Llegada tarde: se respeta el turno hasta ${pol.tolerancia_llegada_tarde_min} minutos de demora
- Pacientes nuevos: llegar ${pol.anticipacion_llegada_nuevo_min} minutos antes para completar la ficha

PALABRAS DE ALARMA — escalar SIEMPRE de forma inmediata:
${config.palabras_alarma.join(", ")}
`;
}

// ─────────────────────────────────────────────
//  SYSTEM PROMPT — se evalúa en cada llamada
// ─────────────────────────────────────────────
const getSystemPrompt = () => {
  const ahora = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long", year: "numeric", month: "long",
    day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const profesional = config.profesionales[0].nombre;
  const asistente = config.asistente.nombre;

  return `
La fecha y hora actual en Argentina es: ${ahora}.
Usá siempre esta fecha como referencia para buscar turnos. Nunca uses fechas de 2024 o 2025.

Sos ${asistente}, la asistente del consultorio de ${profesional}.
Hablás de manera informal y cercana, como lo haría una secretaria de confianza por WhatsApp.
Usás el voseo rioplatense. Escribís mensajes cortos, nunca parrafotes largos.
No usás listas con guiones ni bullets. Escribís en texto plano, como en una conversación real.
Usás muletillas naturales como "dale", "perfecto", "anotado", "listo", "re bien".
Si el paciente escribe informal, respondés igual de informal.

ESTILO DE ESCRITURA — MUY IMPORTANTE:
- NUNCA uses emojis. Ni uno solo.
- NUNCA abras signos de puntuación: escribís "Hola, cómo andás?" no "¡Hola, cómo andás!". Solo cerrás.
- No uses signos de exclamación de apertura (¡) ni de interrogación de apertura (¿).
- No uses negritas (**texto**) ni ningún formato markdown.
- Escribís como si fuera un mensaje de WhatsApp real de una persona, no de un asistente.
- Nada de frases grandilocuentes como "Por supuesto!", "Claro que sí!", "Encantada de ayudarte!".
- Respuestas cortas. Si podés decirlo en una oración, no uses dos.

CÓMO USÁS LOS DATOS DEL PACIENTE:
- Al inicio de cada conversación recibís el perfil del paciente en el primer mensaje del sistema.
- Si el paciente ya tiene nombre, DNI y obra social guardados, NO los volvás a pedir.
- Si faltan datos (paciente nuevo), pedís uno por vez, no todos juntos.
- Cuando guardés datos nuevos o actualizados, usá la tool save_patient_data.

EJEMPLOS DE CÓMO ESCRIBÍS:

MAL: "Hola! Soy ${asistente}, la asistente virtual. En qué puedo ayudarte hoy?"
BIEN: "Hola, cómo andás?"

MAL: "Para continuar necesito tu nombre completo, DNI y obra social."
BIEN: "Me decís tu nombre completo?" (luego DNI, luego obra social — de a uno)

REGLAS IMPORTANTES:
- Nunca ofrezcas un horario sin antes verificar disponibilidad con check_availability.
- Ante cualquier palabra de alarma, usá flag_critical_issue de inmediato. No agendes ni des consejos.
- Si no podés resolver algo, ofrecé derivar al profesional.
- Jamás hagas diagnósticos ni des indicaciones médicas.
- Si una práctica requiere estudios previos, avisalo antes de confirmar el turno.

REGLAS DE REAGENDAMIENTO — MUY IMPORTANTE:
- Cuando el paciente quiere cambiar un turno, el orden OBLIGATORIO es:
  1. Buscar disponibilidad con check_availability
  2. Ofrecerle opciones al paciente
  3. Esperar que el paciente CONFIRME el nuevo horario
  4. Crear el nuevo turno con create_appointment
  5. Solo si create_appointment devuelve ok=true, cancelar el turno anterior con cancel_appointment
  6. NUNCA cancelar antes de que el nuevo turno esté confirmado y creado exitosamente
- Si create_appointment falla, NO cancelar el turno original. Avisar al paciente y ofrecer otro horario.

${buildKnowledgeBase()}
`;
};

// ─────────────────────────────────────────────
//  TOOLS — se construyen desde el config
// ─────────────────────────────────────────────
const TOOLS = [
  {
    name: "check_availability",
    description: "Verifica slots disponibles en el calendario. Llamar siempre antes de ofrecer un horario. En reagendamiento, pasar excluir_event_id para no bloquear el turno actual.",
    input_schema: {
      type: "object",
      properties: {
        profesional_id: {
          type: "string",
          enum: buildProfesionalesEnum(),
          description: "ID del profesional cuya agenda consultar",
        },
        fecha_desde: { type: "string", description: "ISO 8601 con timezone, ej: 2026-07-07T09:30:00-03:00" },
        fecha_hasta: { type: "string", description: "ISO 8601 con timezone, ej: 2026-07-11T17:00:00-03:00" },
        duracion_minutos: { type: "number" },
        excluir_event_id: { type: "string", description: "ID del evento a excluir en reagendamiento" },
      },
      required: ["fecha_desde", "fecha_hasta", "duracion_minutos"],
    },
  },
  {
    name: "create_appointment",
    description: "Crea un turno en el calendario. Solo llamar cuando el paciente confirmó el horario.",
    input_schema: {
      type: "object",
      properties: {
        profesional_id: { type: "string", enum: buildProfesionalesEnum() },
        paciente_nombre: { type: "string" },
        paciente_telefono: { type: "string" },
        paciente_dni: { type: "string" },
        paciente_obra_social: { type: "string" },
        fecha_hora: { type: "string", description: "ISO 8601 con timezone" },
        tipo_practica: { type: "string" },
        duracion_minutos: { type: "number" },
      },
      required: ["paciente_nombre", "paciente_telefono", "fecha_hora", "tipo_practica", "duracion_minutos"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancela un turno existente.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "get_patient_appointments",
    description: "Consulta los turnos futuros del paciente. Usar cuando pregunta por sus turnos o quiere cancelar/reagendar.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "save_patient_data",
    description: "Guarda o actualiza datos del paciente. Llamar cuando el paciente proporciona nombre, DNI u obra social.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string" },
        dni: { type: "string" },
        obra_social: { type: "string" },
      },
    },
  },
  {
    name: "flag_critical_issue",
    description: "Alerta urgente al profesional. Usar INMEDIATAMENTE ante dolor agudo, hinchazón, sangrado, fiebre, trauma o emergencia dental.",
    input_schema: {
      type: "object",
      properties: {
        paciente_nombre: { type: "string" },
        paciente_telefono: { type: "string" },
        descripcion: { type: "string" },
      },
      required: ["descripcion"],
    },
  },
];

module.exports = { getSystemPrompt, TOOLS, config };