-- Schema used by server/repository.js. The server talks to PostgreSQL with a
-- private DATABASE_URL; the browser must never connect to these tables.
CREATE TABLE IF NOT EXISTS app_config (
  id integer PRIMARY KEY,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS teachers (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS checkins (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teacher_workflow (
  id integer PRIMARY KEY CHECK (id = 1),
  data jsonb NOT NULL
);

INSERT INTO teacher_workflow (id, data)
VALUES (1, '{"teacherAttendance":[],"teacherSubstitutions":[],"sheetSync":{"revision":0,"syncedRevision":-1}}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Defense in depth: the web API uses the private database role. No anon/authenticated
-- policy is created, so Supabase's public Data API cannot expose school records.
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_workflow ENABLE ROW LEVEL SECURITY;

-- Read model requested for reporting: id, student, time, and status. Source
-- records remain in the JSONB shape expected by the existing application.
CREATE OR REPLACE VIEW presence_records
WITH (security_invoker = true)
AS
SELECT
  id,
  data->>'alunoId' AS student_id,
  data->>'alunoNome' AS student_name,
  CASE
    WHEN data->>'ts' ~ '^[0-9]+$'
      THEN timestamptz 'epoch' + ((data->>'ts')::bigint * interval '1 millisecond')
    ELSE NULL
  END AS attendance_time,
  'registered'::text AS status,
  data->>'turmaId' AS class_id,
  data->>'sessaoId' AS session_id,
  created_at
FROM checkins;

REVOKE ALL ON presence_records FROM PUBLIC, anon, authenticated;
