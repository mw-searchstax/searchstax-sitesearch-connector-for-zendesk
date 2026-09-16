import { portableCommand } from "../node/portable-runtime.ts";

try {
  const [command = "start", ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("Unexpected arguments.");
  await portableCommand(command, process.env);
} catch {
  console.error(
    "Connector command failed. Check command, configuration, database/schema, connector identity, and encryption key.",
  );
  process.exitCode = 1;
}
