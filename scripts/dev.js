// Runs the API server (restarting on change) and the Vite dev server together.
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const procs = [run('node', ['--watch', 'server/index.js']), run('npx', ['vite'])];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
