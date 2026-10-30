import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createServer } from 'node:http';
import { createApp } from './app.js';

export default httpServerHandler(createServer(createApp(env)));
