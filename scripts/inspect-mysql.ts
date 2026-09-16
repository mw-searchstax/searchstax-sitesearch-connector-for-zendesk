import {
  assertMysqlSchemaCurrent,
  createMysqlConnection,
  inspectMysqlSchema,
} from "../node/mysql-schema.ts";

const url = process.env.MYSQL_URL;
if (!url) throw new Error("MYSQL_URL is required.");
const connection = await createMysqlConnection(url);
try {
  const state = await inspectMysqlSchema(connection);
  console.log(`MySQL schema version: ${state.version}/${state.latest}`);
  await assertMysqlSchemaCurrent(connection);
} finally {
  await connection.end?.();
}
