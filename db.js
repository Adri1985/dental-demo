const crypto = require("crypto");

const USE_DB = !!process.env.DATABASE_URL;
console.log(`[db] modo: ${USE_DB ? "PostgreSQL" : "memoria"}`);

const store = {
  patients: {}, messages: {}, claudeHistory: {}, config: {},
  users: {}, consultorios: {}, invitaciones: [], profiles: [],
};

// ─────────────────────────────────────────────
//  CIFRADO DE CREDENCIALES (AES-256-CBC)
// ─────────────────────────────────────────────
// Las credenciales de los perfiles nunca se guardan en texto plano.
// El formato almacenado es "<iv en hex>:<ciphertext en hex>".

function getEncryptionKey() {
  const k = process.env.ENCRYPTION_KEY || "";
  if (k.length === 32) return Buffer.from(k, "utf8");
  if (!k) {
    console.warn("[crypto] ENCRYPTION_KEY no está seteada — las credenciales se cifran con una clave derivada por defecto. NO usar así en producción.");
  } else {
    console.warn(`[crypto] ENCRYPTION_KEY tiene ${k.length} chars en vez de 32 — se deriva una clave de 32 bytes con sha256.`);
  }
  return crypto.createHash("sha256").update(k).digest();
}

function encrypt(text) {
  if (text === null || text === undefined || text === "") return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${enc.toString("hex")}`;
}

function decrypt(text) {
  if (text === null || text === undefined || text === "") return null;
  const str = String(text);
  const sep = str.indexOf(":");
  // Si no tiene el formato iv:payload asumimos que quedó en texto plano de antes
  if (sep !== 32) return str;
  try {
    const iv  = Buffer.from(str.slice(0, sep), "hex");
    const enc = Buffer.from(str.slice(sep + 1), "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", getEncryptionKey(), iv);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch (e) {
    console.error("[crypto] no se pudo descifrar una credencial:", e.message);
    return null;
  }
}

let pool = null;
if (USE_DB) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : false,
  });
}

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
async function initDB() {
  if (!USE_DB) {
    console.log("[db] corriendo en memoria");
    store.config = {
      horario_manana_desde: "09:30", horario_manana_hasta: "13:00",
      horario_tarde_desde: "14:00", horario_tarde_hasta: "17:00",
      estilo_conversacion: "profesional_amigable",
      bot_whatsapp_number: "15551445115",
    };
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS consultorios (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      consultorio_id INTEGER REFERENCES consultorios(id),
      email          TEXT UNIQUE NOT NULL,
      password_hash  TEXT NOT NULL,
      nombre         TEXT,
      descripcion    TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invitaciones (
      id             SERIAL PRIMARY KEY,
      consultorio_id INTEGER NOT NULL REFERENCES consultorios(id),
      email          TEXT NOT NULL,
      token          TEXT NOT NULL UNIQUE,
      usado          BOOLEAN DEFAULT false,
      expires_at     TIMESTAMPTZ NOT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS patients (
      telefono       TEXT PRIMARY KEY,
      nombre         TEXT,
      dni            TEXT,
      obra_social    TEXT,
      modo           TEXT DEFAULT 'bot',
      consultorio_id INTEGER REFERENCES consultorios(id) DEFAULT 1,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id       SERIAL PRIMARY KEY,
      telefono TEXT NOT NULL REFERENCES patients(telefono),
      role     TEXT NOT NULL,
      text     TEXT NOT NULL,
      ts       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_telefono ON messages(telefono);

    CREATE TABLE IF NOT EXISTS claude_history (
      telefono TEXT PRIMARY KEY REFERENCES patients(telefono),
      history  JSONB NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS consultorio_config (
      clave      TEXT PRIMARY KEY,
      valor      TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coberturas (
      id                   SERIAL PRIMARY KEY,
      obra_social          TEXT NOT NULL,
      descuento_pct        INTEGER NOT NULL DEFAULT 0,
      primera_consulta_only BOOLEAN DEFAULT false,
      activa               BOOLEAN DEFAULT true,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coberturas (
      id                   SERIAL PRIMARY KEY,
      obra_social          TEXT NOT NULL,
      descuento_pct        INTEGER NOT NULL DEFAULT 0,
      primera_consulta_only BOOLEAN DEFAULT false,
      activa               BOOLEAN DEFAULT true,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS integration_profiles (
      id                          SERIAL PRIMARY KEY,
      consultorio_id              INTEGER REFERENCES consultorios(id) ON DELETE CASCADE,
      nombre                      TEXT NOT NULL,
      activo                      BOOLEAN DEFAULT false,
      whatsapp_phone_number_id    TEXT,
      whatsapp_token              TEXT,
      whatsapp_verify_token       TEXT,
      google_service_account_json TEXT,
      calendar_id                 TEXT,
      created_at                  TIMESTAMPTZ DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS practicas (
      id                  SERIAL PRIMARY KEY,
      nombre              TEXT NOT NULL,
      duracion_min        INTEGER NOT NULL DEFAULT 30,
      precio              INTEGER NOT NULL DEFAULT 50,
      requiere            TEXT,
      para_agente         BOOLEAN DEFAULT true,
      para_turno_directo  BOOLEAN DEFAULT true,
      activa              BOOLEAN DEFAULT true,
      orden               INTEGER DEFAULT 0,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    INSERT INTO consultorio_config (clave, valor) VALUES
      ('horario_manana_desde',        '09:30'),
      ('horario_manana_hasta',        '13:00'),
      ('horario_tarde_desde',         '14:00'),
      ('horario_tarde_hasta',         '17:00'),
      ('estilo_conversacion',         'profesional_amigable'),
      ('bot_whatsapp_number',         '15551445115'),
      ('precio_consulta',            '0'),
      ('precio_consulta',             '50000'),
      ('cancelacion_anticipacion_hs', '24'),
      ('tolerancia_llegada_min',      '15'),
      ('anticipacion_nuevo_min',      '10'),
      ('palabras_alarma',             'dolor fuerte, hinchazón, sangrado, fiebre, accidente, golpe, urgencia, emergencia'),
      ('flujo_paciente_nuevo',        '1. Saludar de forma breve\n2. Pedir nombre completo, DNI y obra social (de a uno, nunca todos juntos)\n3. Informar el valor de la consulta\n4. Si acepta, buscar disponibilidad y asignar turno\n5. Confirmar el turno con todos los datos'),
      ('flujo_paciente_existente',    '1. Saludar por su nombre\n2. Preguntar qué necesita\n3. Buscar disponibilidad y asignar turno\n4. Confirmar'),
      ('mensaje_bienvenida',          '')
    ON CONFLICT (clave) DO NOTHING;
  `);
  // Migraciones — agregar columnas nuevas si no existen
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coberturas (
      id                    SERIAL PRIMARY KEY,
      obra_social           TEXT NOT NULL,
      descuento_pct         INTEGER NOT NULL DEFAULT 0,
      primera_consulta_only BOOLEAN DEFAULT false,
      activa                BOOLEAN DEFAULT true,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.log("[db] migracion coberturas:", e.message));

  // Migraciones — agregar columnas nuevas si no existen
  // Esto permite evolucionar el schema sin perder datos
  await pool.query(`
    ALTER TABLE practicas ADD COLUMN IF NOT EXISTS para_agente        BOOLEAN DEFAULT true;
    ALTER TABLE practicas ADD COLUMN IF NOT EXISTS para_turno_directo BOOLEAN DEFAULT true;
    ALTER TABLE practicas ADD COLUMN IF NOT EXISTS precio             INTEGER DEFAULT 50;
  `).catch(e => console.log("[db] migracion practicas:", e.message));

  await pool.query(`
    ALTER TABLE patients ADD COLUMN IF NOT EXISTS consultorio_id INTEGER REFERENCES consultorios(id) DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_patients_consultorio ON patients(consultorio_id);
  `).catch(e => console.log("[db] migracion patients consultorio_id:", e.message));

  await pool.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS es_manual BOOLEAN DEFAULT false;
  `).catch(e => console.log("[db] migracion messages es_manual:", e.message));

  await migrarEnvAPerfil().catch(e => console.log("[migration] error:", e.message));

  console.log("[db] tablas listas (PostgreSQL)");
}

// Corre una sola vez: si el consultorio 1 todavía no tiene perfiles, crea uno
// con las credenciales que hoy viven en las variables de entorno.
async function migrarEnvAPerfil() {
  const { rows: cons } = await pool.query("SELECT id FROM consultorios WHERE id = 1");
  if (!cons.length) return;

  const { rows: existentes } = await pool.query(
    "SELECT id FROM integration_profiles WHERE consultorio_id = 1 LIMIT 1"
  );
  if (existentes.length) return;

  await createProfile({
    consultorio_id:              1,
    nombre:                      "Test mode",
    activo:                      true,
    whatsapp_phone_number_id:    process.env.WHATSAPP_PHONE_NUMBER_ID,
    whatsapp_token:              process.env.WHATSAPP_TOKEN,
    whatsapp_verify_token:       process.env.WHATSAPP_VERIFY_TOKEN,
    google_service_account_json: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    calendar_id:                 process.env.CALENDAR_ID_DR_DIEGO,
  });
  console.log("[migration] perfil 'Test mode' creado desde env vars");
}

// ─────────────────────────────────────────────
//  AUTH — consultorios, users, invitaciones
// ─────────────────────────────────────────────

async function createConsultorio(nombre) {
  if (!USE_DB) {
    const id = Date.now();
    store.consultorios[id] = { id, nombre, created_at: new Date().toISOString() };
    return store.consultorios[id];
  }
  const { rows } = await pool.query("INSERT INTO consultorios (nombre) VALUES ($1) RETURNING *", [nombre]);
  return rows[0];
}

async function getConsultorio(id) {
  if (!USE_DB) return store.consultorios[id] || null;
  const { rows } = await pool.query("SELECT * FROM consultorios WHERE id = $1", [id]);
  return rows[0] || null;
}

async function createUser({ email, password_hash, nombre, descripcion, consultorio_id }) {
  if (!USE_DB) {
    const id = Date.now();
    store.users[email] = { id, email, password_hash, nombre: nombre || null, descripcion: descripcion || null, consultorio_id: consultorio_id || null, created_at: new Date().toISOString() };
    return store.users[email];
  }
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, nombre, descripcion, consultorio_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [email, password_hash, nombre || null, descripcion || null, consultorio_id || null]
  );
  return rows[0];
}

async function getUserByEmail(email) {
  if (!USE_DB) return store.users[email] || null;
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}

async function updateUserConsultorio(userId, consultorio_id) {
  if (!USE_DB) {
    const user = Object.values(store.users).find(u => u.id === userId);
    if (user) user.consultorio_id = consultorio_id;
    return user;
  }
  const { rows } = await pool.query(
    "UPDATE users SET consultorio_id = $1 WHERE id = $2 RETURNING *",
    [consultorio_id, userId]
  );
  return rows[0];
}

async function getUsersByConsultorio(consultorio_id) {
  if (!USE_DB) return Object.values(store.users).filter(u => u.consultorio_id === consultorio_id);
  const { rows } = await pool.query(
    "SELECT id, email, nombre, descripcion, created_at FROM users WHERE consultorio_id = $1 ORDER BY created_at ASC",
    [consultorio_id]
  );
  return rows;
}

async function createInvitacion({ consultorio_id, email, token }) {
  const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (!USE_DB) {
    const inv = { id: Date.now(), consultorio_id, email, token, usado: false, expires_at: expires_at.toISOString() };
    store.invitaciones.push(inv);
    return inv;
  }
  const { rows } = await pool.query(
    "INSERT INTO invitaciones (consultorio_id, email, token, expires_at) VALUES ($1, $2, $3, $4) RETURNING *",
    [consultorio_id, email, token, expires_at]
  );
  return rows[0];
}

async function getInvitacion(token) {
  if (!USE_DB) return store.invitaciones.find(i => i.token === token && !i.usado && new Date(i.expires_at) > new Date()) || null;
  const { rows } = await pool.query(
    "SELECT * FROM invitaciones WHERE token = $1 AND usado = false AND expires_at > NOW()",
    [token]
  );
  return rows[0] || null;
}

async function usarInvitacion(token) {
  if (!USE_DB) { const inv = store.invitaciones.find(i => i.token === token); if (inv) inv.usado = true; return; }
  await pool.query("UPDATE invitaciones SET usado = true WHERE token = $1", [token]);
}

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

async function getConfig() {
  if (!USE_DB) return { ...store.config };
  const { rows } = await pool.query("SELECT clave, valor FROM consultorio_config");
  return Object.fromEntries(rows.map(r => [r.clave, r.valor]));
}

async function setConfig(clave, valor) {
  if (!USE_DB) { store.config[clave] = valor; return; }
  await pool.query(
    `INSERT INTO consultorio_config (clave, valor, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
    [clave, valor]
  );
}

// ─────────────────────────────────────────────
//  PATIENTS
// ─────────────────────────────────────────────

async function getPatient(telefono) {
  if (!USE_DB) return store.patients[telefono] || null;
  const { rows } = await pool.query("SELECT * FROM patients WHERE telefono = $1", [telefono]);
  return rows[0] || null;
}

async function upsertPatient({ telefono, nombre, dni, obra_social, consultorio_id = 1 }) {
  if (!USE_DB) {
    const now = new Date().toISOString();
    const existing = store.patients[telefono];
    store.patients[telefono] = {
      telefono,
      nombre:         nombre         || existing?.nombre      || null,
      dni:            dni            || existing?.dni         || null,
      obra_social:    obra_social    || existing?.obra_social || null,
      consultorio_id: existing?.consultorio_id || consultorio_id,
      modo:           existing?.modo || "bot",
      created_at:     existing?.created_at || now,
      updated_at:     now,
    };
    return store.patients[telefono];
  }
  const { rows } = await pool.query(`
    INSERT INTO patients (telefono, nombre, dni, obra_social, consultorio_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (telefono) DO UPDATE SET
      nombre      = COALESCE(EXCLUDED.nombre, patients.nombre),
      dni         = COALESCE(EXCLUDED.dni, patients.dni),
      obra_social = COALESCE(EXCLUDED.obra_social, patients.obra_social),
      updated_at  = NOW()
    RETURNING *
  `, [telefono, nombre || null, dni || null, obra_social || null, consultorio_id]);
  return rows[0];
}

async function updatePatientData(telefono, { nombre, dni, obra_social }) {
  if (!USE_DB) {
    const p = store.patients[telefono];
    if (!p) return null;
    if (nombre) p.nombre = nombre;
    if (dni) p.dni = dni;
    if (obra_social) p.obra_social = obra_social;
    p.updated_at = new Date().toISOString();
    return p;
  }
  const { rows } = await pool.query(`
    UPDATE patients SET
      nombre      = COALESCE($1, nombre),
      dni         = COALESCE($2, dni),
      obra_social = COALESCE($3, obra_social),
      updated_at  = NOW()
    WHERE telefono = $4 RETURNING *
  `, [nombre || null, dni || null, obra_social || null, telefono]);
  return rows[0];
}

async function setPatientMode(telefono, modo) {
  if (!USE_DB) { if (store.patients[telefono]) store.patients[telefono].modo = modo; return; }
  await pool.query("UPDATE patients SET modo = $1, updated_at = NOW() WHERE telefono = $2", [modo, telefono]);
}

async function getAllPatients(consultorio_id) {
  if (!USE_DB) {
    const todos = Object.values(store.patients);
    const filtrados = consultorio_id
      ? todos.filter(p => !p.consultorio_id || String(p.consultorio_id) === String(consultorio_id))
      : todos;
    return filtrados.map(p => ({
      ...p, total_mensajes: (store.messages[p.telefono] || []).length,
    })).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }
  const { rows } = await pool.query(`
    SELECT p.*, COUNT(m.id)::int AS total_mensajes
    FROM patients p LEFT JOIN messages m ON m.telefono = p.telefono
    WHERE p.consultorio_id = $1
    GROUP BY p.telefono ORDER BY p.updated_at DESC
  `, [consultorio_id || 1]);
  return rows;
}

// ─────────────────────────────────────────────
//  MESSAGES
// ─────────────────────────────────────────────

async function addMessage(telefono, role, text, ts, es_manual = false) {
  if (!USE_DB) {
    if (!store.messages[telefono]) store.messages[telefono] = [];
    store.messages[telefono].push({ role, text, ts: ts || new Date().toISOString(), es_manual });
    return;
  }
  await pool.query(
    "INSERT INTO messages (telefono, role, text, ts, es_manual) VALUES ($1, $2, $3, $4, $5)",
    [telefono, role, text, ts || new Date().toISOString(), es_manual]
  );
}

async function getMessages(telefono) {
  if (!USE_DB) return store.messages[telefono] || [];
  const { rows } = await pool.query("SELECT role, text, ts, es_manual FROM messages WHERE telefono = $1 ORDER BY id ASC", [telefono]);
  return rows;
}

async function clearMessages(telefono) {
  if (!USE_DB) { store.messages[telefono] = []; return; }
  await pool.query("DELETE FROM messages WHERE telefono = $1", [telefono]);
}

// ─────────────────────────────────────────────
//  CLAUDE HISTORY
// ─────────────────────────────────────────────

async function getClaudeHistory(telefono) {
  if (!USE_DB) return store.claudeHistory[telefono] || [];
  const { rows } = await pool.query("SELECT history FROM claude_history WHERE telefono = $1", [telefono]);
  return rows[0]?.history || [];
}

async function saveClaudeHistory(telefono, history) {
  if (!USE_DB) { store.claudeHistory[telefono] = history; return; }
  await pool.query(
    `INSERT INTO claude_history (telefono, history) VALUES ($1, $2)
     ON CONFLICT (telefono) DO UPDATE SET history = EXCLUDED.history`,
    [telefono, JSON.stringify(history)]
  );
}

async function clearClaudeHistory(telefono) {
  if (!USE_DB) { store.claudeHistory[telefono] = []; return; }
  await pool.query("DELETE FROM claude_history WHERE telefono = $1", [telefono]);
}

// ─────────────────────────────────────────────
//  COBERTURAS
// ─────────────────────────────────────────────

async function getCoberturas() {
  if (!USE_DB) return [];
  const { rows } = await pool.query(
    "SELECT * FROM coberturas WHERE activa = true ORDER BY obra_social ASC"
  );
  return rows;
}

async function createCobertura({ obra_social, descuento_pct, primera_consulta_only }) {
  if (!USE_DB) return null;
  const { rows } = await pool.query(
    `INSERT INTO coberturas (obra_social, descuento_pct, primera_consulta_only)
     VALUES ($1, $2, $3) RETURNING *`,
    [obra_social, descuento_pct || 0, primera_consulta_only || false]
  );
  return rows[0];
}

async function updateCobertura(id, campos) {
  if (!USE_DB) return null;
  const sets = [], vals = [];
  let i = 1;
  if (campos.obra_social            !== undefined) { sets.push(`obra_social = $${i++}`);             vals.push(campos.obra_social); }
  if (campos.descuento_pct          !== undefined) { sets.push(`descuento_pct = $${i++}`);           vals.push(campos.descuento_pct); }
  if (campos.primera_consulta_only  !== undefined) { sets.push(`primera_consulta_only = $${i++}`);   vals.push(campos.primera_consulta_only); }
  if (!sets.length) return null;
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE coberturas SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals
  );
  return rows[0];
}

async function deleteCobertura(id) {
  if (!USE_DB) return;
  await pool.query("UPDATE coberturas SET activa = false WHERE id = $1", [id]);
}

// ─────────────────────────────────────────────
//  PRÁCTICAS
// ─────────────────────────────────────────────

async function getPracticas(filtro) {
  // filtro: undefined = todas activas, "agente" = solo para_agente, "turno_directo" = solo para_turno_directo
  if (!USE_DB) return [];
  let where = "activa = true";
  if (filtro === "agente") where += " AND para_agente = true";
  if (filtro === "turno_directo") where += " AND para_turno_directo = true";
  const { rows } = await pool.query(
    `SELECT * FROM practicas WHERE ${where} ORDER BY orden ASC, id ASC`
  );
  return rows;
}

async function createPractica({ nombre, duracion_min, precio, requiere, para_agente, para_turno_directo }) {
  if (!USE_DB) return null;
  const { rows } = await pool.query(
    `INSERT INTO practicas (nombre, duracion_min, precio, requiere, para_agente, para_turno_directo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [nombre, duracion_min || 30, precio != null ? parseInt(precio) : 50, requiere || null,
     para_agente !== false, para_turno_directo !== false]
  );
  return rows[0];
}

async function updatePractica(id, campos) {
  if (!USE_DB) { console.log("[updatePractica] sin DB, modo memoria"); return null; }
  const sets = [];
  const vals = [];
  let i = 1;
  if (campos.nombre             !== undefined) { sets.push(`nombre = $${i++}`);            vals.push(campos.nombre); }
  if (campos.duracion_min       !== undefined) { sets.push(`duracion_min = $${i++}`);      vals.push(campos.duracion_min); }
  if (campos.precio             !== undefined) { sets.push(`precio = $${i++}`);            vals.push(parseInt(campos.precio) || 50); }
  if (campos.requiere           !== undefined) { sets.push(`requiere = $${i++}`);           vals.push(campos.requiere || null); }
  if (campos.para_agente        !== undefined) { sets.push(`para_agente = $${i++}`);       vals.push(campos.para_agente); }
  if (campos.para_turno_directo !== undefined) { sets.push(`para_turno_directo = $${i++}`); vals.push(campos.para_turno_directo); }
  console.log("[updatePractica] sets:", sets, "vals:", vals, "id:", id);
  if (!sets.length) { console.log("[updatePractica] nada que actualizar"); return null; }
  vals.push(id);
  const query = `UPDATE practicas SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`;
  console.log("[updatePractica] query:", query);
  const { rows } = await pool.query(query, vals);
  console.log("[updatePractica] rows:", rows);
  return rows[0];
}

async function deletePractica(id) {
  if (!USE_DB) return;
  // Soft delete — marcar como inactiva
  await pool.query("UPDATE practicas SET activa = false WHERE id = $1", [id]);
}

// ─────────────────────────────────────────────
//  PERFILES DE INTEGRACIÓN
// ─────────────────────────────────────────────
// Campos que se guardan cifrados y se devuelven en claro solo en getActiveProfile.
const CAMPOS_CREDENCIAL = [
  "whatsapp_phone_number_id", "whatsapp_token", "whatsapp_verify_token",
  "google_service_account_json", "calendar_id",
];

function cifrarCredenciales(data) {
  const out = {};
  for (const c of CAMPOS_CREDENCIAL) out[c] = encrypt(data[c]);
  return out;
}

function descifrarPerfil(row) {
  if (!row) return null;
  const out = { ...row };
  for (const c of CAMPOS_CREDENCIAL) out[c] = decrypt(row[c]);
  return out;
}

// Devuelve el perfil sin credenciales en claro: solo si cada campo está seteado.
function resumirPerfil(row) {
  if (!row) return null;
  const configurado = {};
  for (const c of CAMPOS_CREDENCIAL) configurado[c] = !!row[c];
  return {
    id: row.id, consultorio_id: row.consultorio_id, nombre: row.nombre,
    activo: !!row.activo, created_at: row.created_at, updated_at: row.updated_at,
    configurado,
  };
}

async function getProfiles(consultorio_id) {
  if (!USE_DB) {
    return store.profiles
      .filter(p => String(p.consultorio_id) === String(consultorio_id))
      .map(resumirPerfil);
  }
  const { rows } = await pool.query(
    "SELECT * FROM integration_profiles WHERE consultorio_id = $1 ORDER BY created_at ASC",
    [consultorio_id]
  );
  return rows.map(resumirPerfil);
}

async function getActiveProfile(consultorio_id) {
  if (!USE_DB) {
    const p = store.profiles.find(
      p => String(p.consultorio_id) === String(consultorio_id) && p.activo
    );
    return descifrarPerfil(p);
  }
  const { rows } = await pool.query(
    "SELECT * FROM integration_profiles WHERE consultorio_id = $1 AND activo = true LIMIT 1",
    [consultorio_id]
  );
  return descifrarPerfil(rows[0]);
}

// Devuelve el perfil con credenciales en claro. Uso interno (editar/validar).
async function getProfileById(id) {
  if (!USE_DB) return descifrarPerfil(store.profiles.find(p => String(p.id) === String(id)));
  const { rows } = await pool.query("SELECT * FROM integration_profiles WHERE id = $1", [id]);
  return descifrarPerfil(rows[0]);
}

async function createProfile(data) {
  const cif = cifrarCredenciales(data);
  if (!USE_DB) {
    const row = {
      id: store.profiles.length + 1,
      consultorio_id: data.consultorio_id,
      nombre: data.nombre,
      activo: !!data.activo,
      ...cif,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    if (row.activo) {
      store.profiles.forEach(p => {
        if (String(p.consultorio_id) === String(row.consultorio_id)) p.activo = false;
      });
    }
    store.profiles.push(row);
    return resumirPerfil(row);
  }
  // Un solo perfil activo por consultorio
  if (data.activo) {
    await pool.query(
      "UPDATE integration_profiles SET activo = false WHERE consultorio_id = $1",
      [data.consultorio_id]
    );
  }
  const { rows } = await pool.query(
    `INSERT INTO integration_profiles
       (consultorio_id, nombre, activo, whatsapp_phone_number_id, whatsapp_token,
        whatsapp_verify_token, google_service_account_json, calendar_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [data.consultorio_id, data.nombre, !!data.activo,
     cif.whatsapp_phone_number_id, cif.whatsapp_token, cif.whatsapp_verify_token,
     cif.google_service_account_json, cif.calendar_id]
  );
  return resumirPerfil(rows[0]);
}

async function updateProfile(id, data) {
  const sets = [], vals = [];
  let i = 1;
  if (data.nombre !== undefined) { sets.push(`nombre = $${i++}`); vals.push(data.nombre); }
  for (const c of CAMPOS_CREDENCIAL) {
    // undefined = no se tocó. "" = se quiere borrar el valor.
    if (data[c] !== undefined) { sets.push(`${c} = $${i++}`); vals.push(encrypt(data[c])); }
  }
  if (!sets.length) return null;

  if (!USE_DB) {
    const row = store.profiles.find(p => String(p.id) === String(id));
    if (!row) return null;
    if (data.nombre !== undefined) row.nombre = data.nombre;
    for (const c of CAMPOS_CREDENCIAL) if (data[c] !== undefined) row[c] = encrypt(data[c]);
    row.updated_at = new Date().toISOString();
    return resumirPerfil(row);
  }
  sets.push("updated_at = NOW()");
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE integration_profiles SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals
  );
  return resumirPerfil(rows[0]);
}

async function activateProfile(id, consultorio_id) {
  if (!USE_DB) {
    const row = store.profiles.find(p => String(p.id) === String(id));
    if (!row) return null;
    store.profiles.forEach(p => {
      if (String(p.consultorio_id) === String(consultorio_id)) p.activo = false;
    });
    row.activo = true;
    return resumirPerfil(row);
  }
  await pool.query(
    "UPDATE integration_profiles SET activo = false WHERE consultorio_id = $1",
    [consultorio_id]
  );
  const { rows } = await pool.query(
    `UPDATE integration_profiles SET activo = true, updated_at = NOW()
     WHERE id = $1 AND consultorio_id = $2 RETURNING *`,
    [id, consultorio_id]
  );
  return resumirPerfil(rows[0]);
}

async function deleteProfile(id) {
  if (!USE_DB) {
    const idx = store.profiles.findIndex(p => String(p.id) === String(id));
    if (idx >= 0) store.profiles.splice(idx, 1);
    return;
  }
  await pool.query("DELETE FROM integration_profiles WHERE id = $1", [id]);
}

module.exports = {
  initDB,
  // auth
  createConsultorio, getConsultorio,
  createUser, getUserByEmail, updateUserConsultorio, getUsersByConsultorio,
  createInvitacion, getInvitacion, usarInvitacion,
  // coberturas
  getCoberturas, createCobertura, updateCobertura, deleteCobertura,
  // practicas
  getPracticas, createPractica, updatePractica, deletePractica,
  // config
  getConfig, setConfig,
  // patients
  getPatient, upsertPatient, updatePatientData, setPatientMode, getAllPatients,
  // messages
  addMessage, getMessages, clearMessages,
  // claude history
  getClaudeHistory, saveClaudeHistory, clearClaudeHistory,
  // perfiles de integración
  getProfiles, getActiveProfile, getProfileById,
  createProfile, updateProfile, activateProfile, deleteProfile,
  // cifrado
  encrypt, decrypt,
};
