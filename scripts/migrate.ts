// Migration CLI.
//
//   npm run db:migrate      apply pending migrations
//   npm run db:rollback     roll back the most recent migration
//
// Refuses to run without DATABASE_URL. Never contacts production by itself —
// it does exactly what the configured connection string points at, so check it
// before running against anything shared.
import { migrateDown, migrateUp } from "../src/platform/db/migrate.ts";
import { closePool, databaseConfigured } from "../src/platform/db/pool.ts";

const command = process.argv[2] ?? "up";

if (!databaseConfigured()) {
  console.error("DATABASE_URL is not set. Set it to your local PostgreSQL and retry.");
  process.exit(1);
}

try {
  if (command === "up") {
    const { applied, skipped } = await migrateUp();
    if (skipped.length) console.log(`Already applied: ${skipped.join(", ")}`);
    if (applied.length) console.log(`Applied: ${applied.join(", ")}`);
    else console.log("No pending migrations.");
  } else if (command === "down") {
    const rolled = await migrateDown();
    console.log(rolled ? `Rolled back: ${rolled}` : "Nothing to roll back.");
  } else {
    console.error(`Unknown command "${command}". Use "up" or "down".`);
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await closePool();
}
