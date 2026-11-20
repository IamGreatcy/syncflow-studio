import { Hono } from 'hono';
import type { ClipFlowDb } from './db/database.js';
import type { StorageService } from './services/storage.js';
import type { SchedulerEngine } from './scheduler/engine.js';
export declare function createApp(params: {
    db: ClipFlowDb;
    storage: StorageService;
    scheduler: SchedulerEngine;
    webDistDir?: string;
    onRestartRequested?: () => void;
}): Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
//# sourceMappingURL=app.d.ts.map