const { google } = require("googleapis");

const CALENDAR_ID = process.env.CALENDAR_ID_DR_DIEGO;

function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

/**
 * Busca eventos futuros que contengan un teléfono o DNI en la descripción.
 * Usado para reconstruir el perfil del paciente al reiniciar el backend.
 */
async function findPatientByIdentifier(telefono, dni) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const ahora = new Date();
  // Buscar desde hace 1 año para encontrar turnos pasados también
  const desde = new Date(ahora);
  desde.setFullYear(desde.getFullYear() - 1);

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: desde.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 100,
  });

  const eventos = data.items || [];

  for (const ev of eventos) {
    const desc = ev.description || "";
    const matchTel = telefono && desc.includes(`Teléfono: ${telefono}`);
    const matchDni = dni && desc.includes(`DNI: ${dni}`);

    if (matchTel || matchDni) {
      // Extraer datos del paciente de la descripción del evento
      const extraer = (campo) => {
        const match = desc.match(new RegExp(`${campo}: (.+)`));
        return match ? match[1].trim() : null;
      };

      return {
        nombre:      extraer("Paciente"),
        telefono:    extraer("Teléfono"),
        dni:         extraer("DNI"),
        obra_social: extraer("Obra social"),
      };
    }
  }

  return null; // no encontrado
}

/**
 * Busca turnos futuros de un paciente por teléfono o DNI.
 */
async function getPatientAppointments(telefono, dni) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: new Date().toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  const eventos = data.items || [];

  return eventos.filter((ev) => {
    const desc = ev.description || "";
    const matchTel = telefono && desc.includes(`Teléfono: ${telefono}`);
    const matchDni = dni && desc.includes(`DNI: ${dni}`);
    return matchTel || matchDni;
  }).map((ev) => ({
    event_id: ev.id,
    titulo: ev.summary,
    inicio: ev.start.dateTime,
    label: new Date(ev.start.dateTime).toLocaleString("es-AR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Argentina/Buenos_Aires",
    }),
  }));
}

/**
 * Busca slots libres en el calendario del Dr. Diego.
 */
async function checkAvailability({ fecha_desde, fecha_hasta, duracion_minutos }) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const timeMin = new Date(fecha_desde).toISOString();
  const timeMax = new Date(fecha_hasta).toISOString();

  const { data } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
  });

  const eventos = data.items || [];
  const slots = [];
  const desde = new Date(fecha_desde);
  const hasta = new Date(fecha_hasta);
  const ahora = new Date();

  for (let d = new Date(desde); d < hasta; d.setDate(d.getDate() + 1)) {
    const diaSemana = d.getDay();
    if (diaSemana === 0 || diaSemana === 6) continue;

    const franjas = [
      { inicio: 9, inicioMin: 30, fin: 13, finMin: 0 },
      { inicio: 14, inicioMin: 0, fin: 17, finMin: 0 },
    ];

    for (const franja of franjas) {
      let slotStart = new Date(d);
      slotStart.setHours(franja.inicio, franja.inicioMin, 0, 0);
      const franjaFin = new Date(d);
      franjaFin.setHours(franja.fin, franja.finMin, 0, 0);

      while (slotStart < franjaFin) {
        const slotEnd = new Date(slotStart.getTime() + duracion_minutos * 60000);

        if (slotStart > ahora && slotEnd <= franjaFin) {
          const hayConflicto = eventos.some((ev) => {
            const evStart = new Date(ev.start.dateTime || ev.start.date);
            const evEnd = new Date(ev.end.dateTime || ev.end.date);
            return slotStart < evEnd && slotEnd > evStart;
          });

          if (!hayConflicto) {
            slots.push({
              inicio: slotStart.toISOString(),
              label: slotStart.toLocaleString("es-AR", {
                weekday: "long",
                day: "numeric",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "America/Argentina/Buenos_Aires",
              }),
            });
          }
        }

        slotStart = new Date(slotStart.getTime() + 30 * 60000);
      }
    }
  }

  return slots.slice(0, 6);
}

/**
 * Crea un evento con todos los datos del paciente en la descripción.
 * Esto permite reconstruir el perfil después de un reinicio.
 */
async function createAppointment({ paciente_nombre, paciente_telefono, paciente_dni, paciente_obra_social, fecha_hora, tipo_practica, duracion_minutos }) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const start = new Date(fecha_hora);
  const end = new Date(start.getTime() + duracion_minutos * 60000);

  // Descripción estructurada — los campos se usan para reconstruir el perfil
  const description = [
    `Paciente: ${paciente_nombre || ""}`,
    `Teléfono: ${paciente_telefono || ""}`,
    `DNI: ${paciente_dni || ""}`,
    `Obra social: ${paciente_obra_social || ""}`,
    `Práctica: ${tipo_practica}`,
  ].join("\n");

  const event = {
    summary: `${tipo_practica} — ${paciente_nombre}`,
    description,
    start: { dateTime: start.toISOString(), timeZone: "America/Argentina/Buenos_Aires" },
    end: { dateTime: end.toISOString(), timeZone: "America/Argentina/Buenos_Aires" },
  };

  const { data } = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });

  return {
    ok: true,
    event_id: data.id,
    resumen: `Turno confirmado con el Dr. Diego el ${start.toLocaleString("es-AR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Argentina/Buenos_Aires",
    })}`,
  };
}

/**
 * Cancela un evento por ID.
 */
async function cancelAppointment({ event_id }) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: event_id });
  return { ok: true };
}

module.exports = {
  checkAvailability,
  createAppointment,
  cancelAppointment,
  findPatientByIdentifier,
  getPatientAppointments,
};