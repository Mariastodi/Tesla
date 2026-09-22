import { hashPin } from "../server/admin-auth.js";

// Read through stdin so the PIN never appears in shell history or process arguments.
const interactive = process.stdin.isTTY;
let pin = "";
if (interactive) {
  process.stderr.write("Código da coordenação (entrada oculta): ");
  process.stdin.setRawMode(true);
}
try {
  for await (const chunk of process.stdin) {
    let done = false;
    for (const character of chunk.toString()) {
      if (character === "\u0003") process.exit(130);
      if (character === "\n" || character === "\r") {
        done = true;
        break;
      }
      if (character === "\u007f" || character === "\b") pin = pin.slice(0, -1);
      else pin += character;
    }
    if (done) break;
  }
  console.log(await hashPin(pin));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (interactive) {
    process.stdin.setRawMode(false);
    process.stderr.write("\n");
  }
}
