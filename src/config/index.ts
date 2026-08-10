import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { loadEnvConfig, type EnvConfig } from './env.js';

/**
 * YAML 設定載入器
 * - 讀取 config/*.yaml（存在時）
 * - 環境變數覆寫（§17.1 為唯一真值）
 * - 回傳合併後的 typed config
 */

export interface YamlConfig {
  [key: string]: unknown;
}

/** 解析 config 目錄下的 YAML 檔案；檔案不存在時回傳空物件 */
export function loadYamlFile(projectRoot: string, file: string): YamlConfig {
  const abs = resolve(projectRoot, 'config', file);
  if (!existsSync(abs)) return {};
  const raw = readFileSync(abs, 'utf-8');
  const parsed = yaml.load(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config/${file} 必須是 YAML 物件`);
  }
  return parsed as YamlConfig;
}

export interface AppConfig {
  env: EnvConfig;
  /** config/scoring.yaml 原始內容（§8.2 評分表） */
  scoring: YamlConfig;
  /** config/scheduler.yaml 原始內容（§18.2 排程） */
  scheduler: YamlConfig;
}

/** 載入完整設定：YAML + 環境變數覆寫 */
export function loadConfig(projectRoot = process.cwd()): AppConfig {
  const env = loadEnvConfig(process.env);
  const scoring = loadYamlFile(projectRoot, 'scoring.yaml');
  const scheduler = loadYamlFile(projectRoot, 'scheduler.yaml');
  return { env, scoring, scheduler };
}

export { join };
