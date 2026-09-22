// Isolated reception rehearsal. Never reads or writes the school's data.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tesla-demo-"));
const store = {
  config: {
    escola: "Ambiente de teste · dados fictícios",
    tolAntes: 30,
    tolDepois: 60,
    minimo: 75,
  },
  turmas: [
    {
      id: "TESTE",
      nome: "Marketing · Teste",
      curso: "Marketing",
      sala: "Sala de teste",
      inicio: "2026-09-01",
      fim: "2026-12-31",
      ativa: true,
      horarios: [{ dia: 1, inicio: "19:00", fim: "21:00" }],
    },
  ],
  professores: [],
  alunos: [
    {
      id: "teste-aluno",
      nome: "Aluno de Teste Tesla",
      cpfHash: "",
      turmaIds: ["TESTE"],
      ativo: true,
    },
  ],
  checkins: [],
};
await fs.writeFile(path.join(directory, "runtime.json"), JSON.stringify(store));
const child = spawn(process.execPath, ["server.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: "3101",
    DATA_DIR: directory,
    NODE_ENV: "test",
    TEST_NOW: "2026-09-21T22:00:00Z",
    DATABASE_URL: "",
    ADMIN_PIN: "demo-admin-only",
    CPF_SALT: "demo-only-secret-never-use-in-production",
    REQUIRE_DEVICE: "false",
  },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", async () => {
  await fs.rm(directory, { recursive: true, force: true });
  process.exit();
});
