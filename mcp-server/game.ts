import { randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Session, StartInput } from '../shared/types.js';
import type { Config } from './config.js';
import { createProvider, type StoryProvider } from './providers.js';
import { adventureTitle, questItem } from './story.js';

export const uuidSchema = z.string().uuid();
export const startSchema = z.object({ world: z.enum(['fantasy', 'space', 'mystery']).default('fantasy'), language: z.enum(['en', 'es']).default('en'), players: z.array(z.string().trim().min(1).max(32)).min(1).max(6).default(['Mira', 'Leo']) }).strict();
export const actionSchema = z.object({ action: z.string().trim().min(1).max(600), choiceId: z.string().max(60).optional() }).strict();
export const diceSchema = z.object({ sides: z.number().int().min(2).max(100).default(20), count: z.number().int().min(1).max(10).default(1), modifier: z.number().int().min(-100).max(100).default(0) }).strict();
const savedSessionSchema = z.object({
  id: uuidSchema, revision: z.number().int().nonnegative().default(0), title: z.string(), world: startSchema.shape.world, language: startSchema.shape.language,
  players: startSchema.shape.players, status: z.enum(['active', 'ended']),
  scenes: z.array(z.object({ id: uuidSchema, number: z.number().int().min(1).max(8), title: z.string(), narration: z.string(),
    imageUrl: z.string().regex(/^\/api\/(?:images\/[a-f0-9-]{36}\.png|art\/(?:fantasy|space|mystery)\/[1-8]\/[0-2]\.svg)$/),
    imagePrompt: z.string(), choices: z.array(z.object({ id: z.string(), text: z.string(), risky: z.boolean() })).max(3),
    action: z.string().optional(), outcome: z.string().optional(), isEnding: z.boolean(),
  })).min(1).max(8), inventory: z.array(z.string()),
  lastRoll: z.object({ id: uuidSchema, sides: diceSchema.shape.sides, count: diceSchema.shape.count, modifier: diceSchema.shape.modifier,
    rolls: z.array(z.number().int()), total: z.number().int(), success: z.boolean(), used: z.boolean(), }).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), provider: z.enum(['demo', 'bedrock']), warnings: z.array(z.string()),
});
export class GameError extends Error { constructor(message: string, public status = 400) { super(message); } }

export class Game {
  readonly events = new EventEmitter();
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Promise<unknown>>();
  private provider: StoryProvider;
  constructor(readonly config: Config, provider?: StoryProvider, private roll = randomInt) {
    this.provider = provider ?? createProvider(config); this.events.setMaxListeners(0);
  }
  async init() {
    await mkdir(this.config.dataDir, { recursive: true });
    for (const file of await readdir(this.config.dataDir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      try {
        const session = savedSessionSchema.parse(JSON.parse(await readFile(path.join(this.config.dataDir, file), 'utf8')));
        if (file === `${session.id}.json`) this.sessions.set(session.id, session);
      } catch { console.warn(`Skipped unreadable saved session: ${file}`); }
    }
  }
  get(id: string): Session {
    if (!uuidSchema.safeParse(id).success) throw new GameError('Invalid session ID');
    const session = this.sessions.get(id); if (!session) throw new GameError('Adventure not found', 404);
    return structuredClone(session);
  }
  private async save(session: Session) {
    session.revision++;
    session.updatedAt = new Date().toISOString();
    const filename = path.join(this.config.dataDir, `${session.id}.json`);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(session, null, 2), { mode: 0o600 });
    await rename(temporary, filename);
    this.sessions.set(session.id, structuredClone(session));
    this.events.emit(session.id, structuredClone(session));
    return structuredClone(session);
  }
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work); this.queues.set(id, next);
    try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  private assertActive(session: Session) { if (session.status !== 'active') throw new GameError('This adventure has ended', 409); }
  private async addScene(session: Session, action?: string, success?: boolean, forceEnd = false, choiceIndex = 0) {
    session.provider = this.config.provider;
    const { scene, warnings } = await this.provider.generate({ session: structuredClone(session), action, success, forceEnd, choiceIndex });
    const id = randomUUID(); let imageUrl: string | null = null;
    session.warnings = [...warnings];
    try { imageUrl = await this.provider.image(scene, session, id); }
    catch (error) {
      console.warn('Bedrock image unavailable:', error instanceof Error ? error.name : 'UnknownError');
      session.warnings.push(session.language === 'es' ? 'La imagen de Bedrock no está disponible. Se muestra una ilustración local.' : 'Bedrock image is unavailable. A local illustration is shown.');
    }
    session.scenes.push({ ...scene, id, imageUrl: imageUrl ?? `/api/art/${session.world}/${scene.isEnding ? 6 : scene.number}/${choiceIndex}.svg` });
    if (scene.isEnding) session.status = 'ended';
  }
  async start(input: StartInput): Promise<Session> {
    const parsed = startSchema.parse(input); const now = new Date().toISOString();
    const session: Session = { id: randomUUID(), revision: 0, ...parsed, title: adventureTitle(parsed.world, parsed.language), status: 'active', scenes: [], inventory: [], lastRoll: null, createdAt: now, updatedAt: now, provider: this.config.provider, warnings: [] };
    await this.addScene(session); return this.save(session);
  }
  async action(id: string, input: z.input<typeof actionSchema>): Promise<Session> {
    const parsed = actionSchema.parse(input);
    return this.exclusive(id, async () => {
      const session = this.get(id); this.assertActive(session);
      const current = session.scenes.at(-1)!;
      const choice = parsed.choiceId ? current.choices.find(c => c.id === parsed.choiceId) : current.choices.find(c => c.text.toLocaleLowerCase() === parsed.action.toLocaleLowerCase());
      if (parsed.choiceId && !choice) throw new GameError('That choice is no longer available. Refresh the scene.', 409);
      let success: boolean | undefined;
      if (choice?.risky) {
        // Only a fresh, unmodified single d20 can resolve a story check.
        if (!session.lastRoll || session.lastRoll.used || session.lastRoll.sides !== 20 || session.lastRoll.count !== 1 || session.lastRoll.modifier !== 0) session.lastRoll = this.makeRoll(20, 1, 0);
        success = session.lastRoll.success; session.lastRoll.used = true;
      }
      const index = choice ? current.choices.indexOf(choice) : 0;
      const action = choice?.text ?? parsed.action;
      if ((choice && !choice.risky) || success) {
        const reward = session.scenes.length >= 3 ? questItem(session.world, session.language) : session.language === 'es' ? (index === 2 ? 'Promesa de un aliado' : 'Pista del camino') : (index === 2 ? 'An ally’s promise' : 'Trail clue');
        if (!session.inventory.includes(reward)) session.inventory.push(reward);
      }
      await this.addScene(session, action, success, session.scenes.length >= this.config.maxScenes - 1, index);
      return this.save(session);
    });
  }
  private makeRoll(sides: number, count: number, modifier: number) {
    const rolls = Array.from({ length: count }, () => this.roll(1, sides + 1));
    const total = rolls.reduce((sum, n) => sum + n, modifier);
    return { id: randomUUID(), sides, count, modifier, rolls, total, success: total >= 11, used: false };
  }
  async dice(id: string, input: z.input<typeof diceSchema> = {}) {
    const parsed = diceSchema.parse(input);
    return this.exclusive(id, async () => { const session = this.get(id); this.assertActive(session); session.lastRoll = this.makeRoll(parsed.sides, parsed.count, parsed.modifier); return this.save(session); });
  }
  async end(id: string) {
    return this.exclusive(id, async () => {
      const session = this.get(id); if (session.status === 'ended') return session;
      await this.addScene(session, session.language === 'es' ? 'Terminar nuestra aventura' : 'Bring our adventure to a close', undefined, true);
      return this.save(session);
    });
  }
}
