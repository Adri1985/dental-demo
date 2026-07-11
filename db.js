const { Pool } = require("pg");

// Una sola variable de entorno maneja todo:
// local:  DATABASE_URL=postgresql://localhost:5432/dental_demo
// Render: DATABASE_URL=postgresql://user:pass@host:5432/dbname
console.log("[db] DATABASE_URL:", process.env.DATABASE_URL ? "definida" : "UNDEFINED");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // En Render la conexión es SSL, localmente no
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});

// ─────────────────────────────────────────────
//  INICIALIZACIÓN — crea las tablas si no existen
// ─────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      telefono      TEXT PRIMARY KEY,
      nombre        TEXT,
      dni           TEXT,
      obra_social   TEXT,
      modo          TEXT DEFAULT 'bot',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            SERIAL PRIMARY KEY,
      telefono      TEXT NOT NULL REFERENCES patients(telefono),
      role          TEXT NOT NULL,
      text          TEXT NOT NULL,
      ts            TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_telefono ON messages(telefono);

    CREATE TABLE IF NOT EXISTS claude_history (
      telefono      TEXT PRIMARY KEY REFERENCES patients(telefono),
      history       JSONB NOT NULL DEFAULT '[]'
    );
  `);
  console.log("[db] tablas listas");
}

// ─────────────────────────────────────────────
//  PATIENTS
// ─────────────────────────────────────────────

async function getPatient(telefono) {
  const { rows } = await pool.query(
    "SELECT * FROM patients WHERE telefono = $1",
    [telefono]
  );
  return rows[0] || null;
}

async function upsertPatient({ telefono, nombre, dni, obra_social }) {
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
  const { rows } = await pool.query(`
    UPDATE patients SET
      nombre      = COALESCE($1, nombre),
      dni         = COALESCE($2, dni),
      obra_social = COALESCE($3, obra_social),
      updated_at  = NOW()
    WHERE telefono = $4
    RETURNING *
  `, [nombre || null, dni || null, obra_social || null, telefono]);
  return rows[0];
}

async function setPatientMode(telefono, modo) {
  await pool.query(
    "UPDATE patients SET modo = $1, updated_at = NOW() WHERE telefono = $2",
    [modo, telefono]
  );
}

async function getAllPatients() {
  const { rows } = await pool.query(`
    SELECT p.*, COUNT(m.id)::int AS total_mensajes
    FROM patients p
    LEFT JOIN messages m ON m.telefono = p.telefono
    GROUP BY p.telefono
    ORDER BY p.updated_at DESC
  `);
  return rows;
}

// ─────────────────────────────────────────────
//  MESSAGES (display history)
// ─────────────────────────────────────────────

async function addMessage(telefono, role, text, ts) {
  await pool.query(
    "INSERT INTO messages (telefono, role, text, ts) VALUES ($1, $2, $3, $4)",
    [telefono, role, text, ts || new Date().toISOString()]
  );
}

async function getMessages(telefono) {
  const { rows } = await pool.query(
    "SELECT role, text, ts FROM messages WHERE telefono = $1 ORDER BY id ASC",
    [telefono]
  );
  return rows;
}

async function clearMessages(telefono) {
  await pool.query("DELETE FROM messages WHERE telefono = $1", [telefono]);
}

// ─────────────────────────────────────────────
//  CLAUDE HISTORY
// ─────────────────────────────────────────────

async function getClaudeHistory(telefono) {
  const { rows } = await pool.query(
    "SELECT history FROM claude_history WHERE telefono = $1",
    [telefono]
  );
  return rows[0]?.history || [];
}

async function saveClaudeHistory(telefono, history) {
  await pool.query(`
    INSERT INTO claude_history (telefono, history)
    VALUES ($1, $2)
    ON CONFLICT (telefono) DO UPDATE SET history = EXCLUDED.history
  `, [telefono, JSON.stringify(history)]);
}

async function clearClaudeHistory(telefono) {
  await pool.query("DELETE FROM claude_history WHERE telefono = $1", [telefono]);
}

module.exports = {
  initDB,
  getPatient,
  upsertPatient,
  updatePatientData,
  setPatientMode,
  getAllPatients,
  addMessage,
  getMessages,
  clearMessages,
  getClaudeHistory,
  saveClaudeHistory,
  clearClaudeHistory,
};