// Imports config.ts with whatever argv and env this process was started with and prints the result as JSON.
import { config } from "../apps/proactive-dpi-be/src/config.ts";

console.log(JSON.stringify({ config, loadEnvCalls: (globalThis as { __loadEnvCalls?: string[] }).__loadEnvCalls }));
