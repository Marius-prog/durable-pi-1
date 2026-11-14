// Preloaded into the config probe: records loadEnvFile calls instead of reading the project .env.
const calls: string[] = [];
(globalThis as { __loadEnvCalls?: string[] }).__loadEnvCalls = calls;
process.loadEnvFile = (path?: string | URL | Buffer) => void calls.push(String(path));
