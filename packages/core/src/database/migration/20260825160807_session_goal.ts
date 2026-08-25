import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260825160807_session_goal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_goal\` (
          \`session_id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`objective\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`max_rounds\` integer NOT NULL,
          \`max_tokens\` integer NOT NULL,
          \`rounds_started\` integer DEFAULT 0 NOT NULL,
          \`tokens_used\` integer DEFAULT 0 NOT NULL,
          \`blocked_code\` text,
          \`blocked_message\` text,
          CONSTRAINT \`fk_session_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
