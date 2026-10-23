import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  PROVIDER: z.enum(['demo', 'bedrock']).default('demo'),
  HOST_MODE: z.enum(['ollama', 'anthropic', 'disabled']).default('ollama'),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().trim().min(1).max(200).default('qwen3:4b-instruct-2507-q4_K_M'),
  OLLAMA_GENERATION_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(240_000).default(120_000),
  RPG_MCP_URL: z.string().url().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  TEXT_MODEL_ID: z.string().default('amazon.nova-lite-v1:0'),
  IMAGE_MODEL_ID: z.string().default('amazon.nova-canvas-v1:0'),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_ORIGIN: z.string().url().optional(),
});
export type Config = ReturnType<typeof readConfig>;
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  return { port: parsed.PORT, host: parsed.HOST, provider: parsed.PROVIDER, hostMode: parsed.HOST_MODE,
    ollamaBaseUrl: parsed.OLLAMA_BASE_URL, ollamaModel: parsed.OLLAMA_MODEL, ollamaGenerationTimeoutMs: parsed.OLLAMA_GENERATION_TIMEOUT_MS, mcpUrl: parsed.RPG_MCP_URL ?? `http://127.0.0.1:${parsed.PORT}/mcp`,
    region: parsed.AWS_REGION, textModel: parsed.TEXT_MODEL_ID, imageModel: parsed.IMAGE_MODEL_ID,
    dataDir: path.resolve(parsed.DATA_DIR), publicOrigin: parsed.PUBLIC_ORIGIN ? new URL(parsed.PUBLIC_ORIGIN).origin : undefined,
    maxScenes: 8, version: '1.0.0' };
}
