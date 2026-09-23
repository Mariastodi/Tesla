import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { rootDir, dataDir, runtimeFile, production } from "./config.js";
import { teachersFromClasses, connectClassesToTeachers } from "./domain.js";
export const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
    })
  : null;
export const transaction = new AsyncLocalStorage();
const database = () => transaction.getStore() || pool;
async function readSeed() {
  if (production)
    return {
      config: {
        escola: "Instituto Tecnológico Tesla",
        minimo: 75,
        tolAntes: 30,
        tolDepois: 60,
      },
      turmas: [],
      professores: [],
      alunos: [],
      checkins: [],
    };
  const [config, classes, students] = await Promise.all([
    fs
      .readFile(path.join(dataDir, "config.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT")
          return {
            escola: "Instituto Tecnológico Tesla",
            minimo: 75,
            tolAntes: 30,
            tolDepois: 60,
          };
        throw error;
      }),
    fs
      .readFile(path.join(dataDir, "turmas.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      }),
    fs
      .readFile(path.join(dataDir, "alunos.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      }),
  ]);
  const rawClasses = Object.entries(classes).map(([id, value]) => ({
    id,
    ...value,
  }));
  const professores = teachersFromClasses(rawClasses);
  return {
    config: { ...config, pin: "" },
    turmas: connectClassesToTeachers(rawClasses, professores),
    professores,
    alunos: Object.entries(students).map(([id, value]) => ({ id, ...value })),
    checkins: [],
  };
}

async function readFileStore() {
  try {
    const store = JSON.parse(await fs.readFile(runtimeFile, "utf8"));
    if (!store.professores)
      store.professores = teachersFromClasses(store.turmas);
    store.turmas = connectClassesToTeachers(store.turmas, store.professores);
    return normalizeWorkflow(store);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const seed = normalizeWorkflow(await readSeed());
    await writeFileStore(seed);
    return seed;
  }
}
async function writeFileStore(store) {
  await fs.mkdir(dataDir, { recursive: true });
  const temporary = `${runtimeFile}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
  await fs.rename(temporary, runtimeFile);
  return store;
}

async function setupPostgres() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS app_config (id integer primary key, data jsonb not null); CREATE TABLE IF NOT EXISTS classes (id text primary key, data jsonb not null); CREATE TABLE IF NOT EXISTS teachers (id text primary key, data jsonb not null); CREATE TABLE IF NOT EXISTS students (id text primary key, data jsonb not null); CREATE TABLE IF NOT EXISTS checkins (id text primary key, data jsonb not null, created_at timestamptz not null default now())`,
  );
  const migration = await fs.readFile(
    path.join(rootDir, "server/migrations/001_teacher_workflow.sql"),
    "utf8",
  );
  await pool.query(migration);
  const count = await pool.query(
    "SELECT count(*)::int AS count FROM app_config",
  );
  if (count.rows[0].count === 0) {
    const seed = await readSeed();
    await pool.query("INSERT INTO app_config (id, data) VALUES (1, $1)", [
      seed.config,
    ]);
    for (const item of seed.turmas)
      await pool.query("INSERT INTO classes (id, data) VALUES ($1, $2)", [
        item.id,
        item,
      ]);
    for (const item of seed.professores)
      await pool.query("INSERT INTO teachers (id, data) VALUES ($1, $2)", [
        item.id,
        item,
      ]);
    for (const item of seed.alunos)
      await pool.query("INSERT INTO students (id, data) VALUES ($1, $2)", [
        item.id,
        item,
      ]);
  }
}
export async function readStore() {
  if (!pool) return readFileStore();
  const [config, classes, teachers, students, checkins, workflow] =
    await Promise.all([
      database().query("SELECT data FROM app_config WHERE id = 1"),
      database().query("SELECT id, data FROM classes"),
      database().query("SELECT id, data FROM teachers"),
      database().query("SELECT id, data FROM students"),
      database().query("SELECT data FROM checkins ORDER BY created_at DESC"),
      database().query("SELECT data FROM teacher_workflow WHERE id = 1"),
    ]);
  const rawClasses = classes.rows.map((row) => row.data);
  const professores = teachers.rows.length
    ? teachers.rows.map((row) => row.data)
    : teachersFromClasses(rawClasses);
  return {
    ...normalizeWorkflow(workflow.rows[0]?.data || {}),
    config: config.rows[0]?.data || {},
    turmas: connectClassesToTeachers(rawClasses, professores),
    professores,
    alunos: students.rows.map((row) => row.data),
    checkins: checkins.rows.map((row) => row.data),
  };
}
export async function writeStore(store) {
  normalizeWorkflow(store);
  store.sheetSync.revision += 1;
  if (!pool) return writeFileStore(store);
  const client = database();
  try {
    await client.query("UPDATE app_config SET data = $1 WHERE id = 1", [
      store.config,
    ]);
    await client.query("DELETE FROM classes WHERE NOT (id = ANY($1::text[]))", [
      store.turmas.map((item) => item.id),
    ]);
    for (const item of store.turmas)
      await client.query(
        "INSERT INTO classes (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
        [item.id, item],
      );
    for (const item of store.professores || [])
      await client.query(
        "INSERT INTO teachers (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
        [item.id, item],
      );
    for (const item of store.alunos)
      await client.query(
        "INSERT INTO students (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
        [item.id, item],
      );
    await saveWorkflow(store);
    return store;
  } catch (error) {
    throw error;
  }
}
export async function addCheckin(store, checkin) {
  if (store.checkins.some((item) => item.id === checkin.id))
    return {
      created: false,
      checkin: store.checkins.find((item) => item.id === checkin.id),
    };
  store.checkins.unshift(checkin);
  if (pool)
    await database().query("INSERT INTO checkins (id, data) VALUES ($1, $2)", [
      checkin.id,
      checkin,
    ]);
  else await writeFileStore(store);
  return { created: true, checkin };
}

export const repositoryReady = pool ? setupPostgres() : Promise.resolve();

function normalizeWorkflow(store) {
  store.teacherAttendance ||= [];
  store.teacherSubstitutions ||= [];
  store.sheetSync = { revision: 0, syncedRevision: -1, ...store.sheetSync };
  return store;
}
export async function saveWorkflow(store, changed = false) {
  normalizeWorkflow(store);
  if (changed) store.sheetSync.revision += 1;
  if (!pool) return writeFileStore(store);
  await database().query("UPDATE teacher_workflow SET data = $1 WHERE id = 1", [
    {
      teacherAttendance: store.teacherAttendance,
      teacherSubstitutions: store.teacherSubstitutions,
      sheetSync: store.sheetSync,
    },
  ]);
}
let localQueue = Promise.resolve();
export async function withStoreLock(action) {
  const execute = async () => {
    await repositoryReady;
    if (!pool) return action();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(74823901)");
      const value = await transaction.run(client, action);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  if (pool) return execute();
  const result = localQueue.then(execute, execute);
  localQueue = result.catch(() => {});
  return result;
}
