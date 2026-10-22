export type Language = 'en' | 'es';
export type World = 'fantasy' | 'space' | 'mystery';
export interface Choice { id: string; text: string; risky: boolean }
export interface Scene {
  id: string; number: number; title: string; narration: string;
  imageUrl: string; imagePrompt: string; choices: Choice[];
  action?: string; outcome?: string; isEnding: boolean;
}
export interface DiceRoll {
  id: string; sides: number; count: number; rolls: number[]; modifier: number;
  total: number; success: boolean; used: boolean;
}
export interface Session {
  id: string; revision: number; title: string; world: World; language: Language; players: string[];
  status: 'active' | 'ended'; scenes: Scene[]; inventory: string[];
  lastRoll: DiceRoll | null; createdAt: string; updatedAt: string;
  provider: 'demo' | 'bedrock'; warnings: string[];
}
export interface StartInput { world: World; language: Language; players: string[] }
export interface AppConfig { provider: 'demo' | 'bedrock'; maxScenes: number; version: string }
