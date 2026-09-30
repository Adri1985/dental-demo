const USE_DB = !!process.env.DATABASE_URL;
console.log(`[db] modo: ${USE_DB ? "PostgreSQL" : "memoria"}`);

const store = {
  patients: {}, messages: {}, claudeHistory: {}, config: {},
  users: {}, consultorios: {}, invitaciones: [],
};

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
      telefono    TEXT PRIMARY KEY,
      nombre      TEXT,
      dni         TEXT,
      obra_social TEXT,
      modo        TEXT DEFAULT 'bot',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
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

    INSERT INTO consultorio_config (clave, valor) VALUES
      ('horario_manana_desde', '09:30'),
      ('horario_manana_hasta', '13:00'),
      ('horario_tarde_desde',  '14:00'),
      ('horario_tarde_hasta',  '17:00'),
      ('estilo_conversacion',  'profesional_amigable'),
      ('bot_whatsapp_number',  '15551445115')
    ON CONFLICT (clave) DO NOTHING;
  `);
  console.log("[db] tablas listas (PostgreSQL)");
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

async function upsertPatient({ telefono, nombre, dni, obra_social }) {
  if (!USE_DB) {
    const now = new Date().toISOString();
    const existing = store.patients[telefono];
    store.patients[telefono] = {
      telefono,
      nombre:      nombre      || existing?.nombre      || null,
      dni:         dni         || existing?.dni         || null,
      obra_social: obra_social || existing?.obra_social || null,
      modo:        existing?.modo || "bot",
      created_at:  existing?.created_at || now,
      updated_at:  now,
    };
    return store.patients[telefono];
  }
  const { rows } = await pool.query(`
    INSERT INTO patients (telefono, nombre, dni, obra_social)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telefono) DO UPDATE SET
      nombre      = COALESCE(EXCLUDED.nombre, patients.nombre),
      dni         = COALESCE(EXCLUDED.dni, patients.dni),
      obra_social = COALESCE(EXCLUDED.obra_social, patients.obra_social),
      updated_at  = NOW()
    RETURNING *
  `, [telefono, nombre || null, dni || null, obra_social || null]);
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

async function getAllPatients() {
  if (!USE_DB) {
    return Object.values(store.patients).map(p => ({
      ...p, total_mensajes: (store.messages[p.telefono] || []).length,
    })).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }
  const { rows } = await pool.query(`
    SELECT p.*, COUNT(m.id)::int AS total_mensajes
    FROM patients p LEFT JOIN messages m ON m.telefono = p.telefono
    GROUP BY p.telefono ORDER BY p.updated_at DESC
  `);
  return rows;
}

// ─────────────────────────────────────────────
//  MESSAGES
// ─────────────────────────────────────────────

async function addMessage(telefono, role, text, ts) {
  if (!USE_DB) { if (!store.messages[telefono]) store.messages[telefono] = []; store.messages[telefono].push({ role, text, ts: ts || new Date().toISOString() }); return; }
  await pool.query("INSERT INTO messages (telefono, role, text, ts) VALUES ($1, $2, $3, $4)", [telefono, role, text, ts || new Date().toISOString()]);
}

async function getMessages(telefono) {
  if (!USE_DB) return store.messages[telefono] || [];
  const { rows } = await pool.query("SELECT role, text, ts FROM messages WHERE telefono = $1 ORDER BY id ASC", [telefono]);
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

module.exports = {
  initDB,
  // auth
  createConsultorio, getConsultorio,
  createUser, getUserByEmail, updateUserConsultorio, getUsersByConsultorio,
  createInvitacion, getInvitacion, usarInvitacion,
  // config
  getConfig, setConfig,
  // patients
  getPatient, upsertPatient, updatePatientData, setPatientMode, getAllPatients,
  // messages
  addMessage, getMessages, clearMessages,
  // claude history
  getClaudeHistory, saveClaudeHistory, clearClaudeHistory,
};
