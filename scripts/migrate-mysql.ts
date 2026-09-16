import {
  applyMysqlMigrations,
  createMysqlConnection,
} from "../node/mysql-schema.ts";

const url = process.env.MYSQL_URL;
if (!url) throw new Error("MYSQL_URL is required.");
const connection = await createMysqlConnection(url);
try {
  const result = await applyMysqlMigrations(connection);
  console.log(
    result.appliedVersions.length
      ? `Applied MySQL migrations: ${result.appliedVersions.join(", ")}`
      : `MySQL schema is current at version ${result.toVersion}.`,
  );
} finally {
  await connection.end?.();
}
