import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.env.TZ = "America/Fortaleza";
export const rootDir = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
export const dataDir = path.resolve(
  process.env.DATA_DIR || path.join(rootDir, "dados"),
);
export const runtimeFile = path.join(dataDir, "runtime.json");
export const salt = process.env.CPF_SALT || "presenca-tesla-local-salt";
export const adminPin = process.env.ADMIN_PIN || "";
export const production = process.env.NODE_ENV === "production";
if (
  production &&
  (!process.env.DATABASE_URL || salt.length < 32 || adminPin.length < 12)
)
  throw new Error(
    "Produção exige DATABASE_URL, CPF_SALT (32 caracteres) e ADMIN_PIN (12 caracteres).",
  );
