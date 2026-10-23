#!/usr/bin/env node
import { register } from 'tsx/esm/api';
register();
const { main } = await import('../src/index.ts');
try { await main(); }
catch (error) { process.stderr.write(`${JSON.stringify({ error: typeof error?.toJSON === 'function' ? error.toJSON() : { code: 'CLI_ERROR', message: error?.message ?? String(error) } })}\n`); process.exitCode = 1; }
