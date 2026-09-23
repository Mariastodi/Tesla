CREATE TABLE IF NOT EXISTS teacher_workflow (
  id integer PRIMARY KEY CHECK (id = 1),
  data jsonb NOT NULL
);
INSERT INTO teacher_workflow (id, data)
VALUES (1, '{"teacherAttendance":[],"teacherSubstitutions":[],"sheetSync":{"revision":0,"syncedRevision":-1}}'::jsonb)
ON CONFLICT (id) DO NOTHING;
