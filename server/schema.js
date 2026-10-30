import { sqliteTable, text, integer, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  created_at: integer('created_at').notNull(),
});
export const sessions = sqliteTable('sessions', {
  token_hash: text('token_hash').primaryKey(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires_at: integer('expires_at').notNull(),
}, table => [index('sessions_expiry').on(table.expires_at)]);
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  source: text('source').notNull(),
  revision: integer('revision').notNull().default(1),
  updated_at: integer('updated_at').notNull(),
}, table => [
  index('documents_owner').on(table.user_id, table.updated_at),
  check('title_length', sql`length(${table.title}) BETWEEN 1 AND 100`),
  check('source_length', sql`length(${table.source}) <= 100000`),
]);
export const authLimits = sqliteTable('auth_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  reset_at: integer('reset_at').notNull(),
});
