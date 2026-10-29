// Налаштування з оточення (див. deploy/kapshuk.service)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.join(here, '..');
export const HOST = process.env.HOST || '0.0.0.0';
export const PORT = Number(process.env.PORT || 8792);
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const WEB_DIR = path.join(ROOT, 'dist', 'web');
export const HA_URL = process.env.HA_URL || 'http://127.0.0.1:8123';
// Звідки панель HA може просити посилання входу (CORS)
export const HA_ORIGINS = (process.env.HA_ORIGINS || 'http://192.168.31.94:8123,http://homeassistant.local:8123')
  .split(',').map((s) => s.trim()).filter(Boolean);
export const TZ = 'Europe/Kyiv';
// KAPSHUK_NO_SYNC=1 — не ходити в Monobank (перевірки, розробка)
export const NO_SYNC = process.env.KAPSHUK_NO_SYNC === '1';
