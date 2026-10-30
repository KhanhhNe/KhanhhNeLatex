import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/schema.js',
  out: './migrations',
  dialect: 'sqlite',
});
