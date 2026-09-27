/**
 * Human-authored playbooks in playbooks/*.yaml.
 * A proposal may name one of these ids. It may not invent one.
 */

import fs from "node:fs";
import path from "node:path";
import { ACTION_IDS, PERMISSION_LEVELS, ROOT_CAUSE_CLASSES, type ActionId, type PermissionLevel, type RootCauseClass } from "./contracts.js";

const ALERTS = ["tech", "ops", "engineer", "truck"] as const;

export const PLAYBOOK_IDS = [
  "ota_allowlisted_version",
  "reboot_wait_90s_retest",
  "reseat_j3_can_capture_counters",
  "monitor_7_days",
  "isolate_no_actuate",
  "hq_recovery_after_field_playbook",
  "commissioning_photos",
  "wiring_sense_photos",
  "monitor_grid_home",
  "hold_unknown",
] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

export interface Playbook {
  id: PlaybookId;
  version: number;
  class: RootCauseClass;
  max_level: PermissionLevel;
  action: ActionId;
  photos_required: string[];
  checklist: string[];
  alerts: Array<(typeof ALERTS)[number]>;
}

let cache: Playbook[] | null = null;

export function loadPlaybooks(directory = path.join(process.cwd(), "playbooks")): Playbook[] {
  if (cache && directory === path.join(process.cwd(), "playbooks")) return cache;
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".yaml")).sort();
  const books = files.map((name) => parsePlaybook(fs.readFileSync(path.join(directory, name), "utf8"), name));
  if (directory === path.join(process.cwd(), "playbooks")) cache = books;
  return books;
}

export function playbookById(id: string, directory?: string): Playbook | undefined {
  return loadPlaybooks(directory).find((book) => book.id === id);
}

export function playbookForClass(rootCause: RootCauseClass, directory?: string): Playbook {
  const matches = loadPlaybooks(directory).filter((book) => book.class === rootCause);
  if (matches.length !== 1) {
    throw new Error(`class ${rootCause} must have exactly one authored playbook`);
  }
  return matches[0] as Playbook;
}

export function parsePlaybook(text: string, file: string): Playbook {
  const scalar: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let listKey: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item?.[1] && listKey) {
      lists[listKey]?.push(item[1].trim());
      continue;
    }
    const pair = /^([a-z0-9_]+):\s*(.*)$/.exec(raw.trim());
    if (!pair?.[1]) continue;
    const key = pair[1];
    const value = pair[2]?.trim() ?? "";
    if (value === "") {
      listKey = key;
      lists[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      listKey = null;
      lists[key] = value
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    } else {
      listKey = null;
      scalar[key] = value;
    }
  }

  const id = scalar.id;
  const rootCause = scalar.class;
  const level = scalar.max_level;
  const action = scalar.action;
  if (!isPlaybookId(id) || !isClass(rootCause) || !isLevel(level) || !isAction(action)) {
    throw new Error(`playbook ${file} is missing a closed-set field`);
  }
  const alerts = lists.alerts ?? [];
  if (alerts.some((alert) => !ALERTS.includes(alert as (typeof ALERTS)[number]))) {
    throw new Error(`playbook ${file} has an alert outside the catalog`);
  }
  return {
    id,
    version: Number(scalar.version),
    class: rootCause,
    max_level: level,
    action,
    photos_required: lists.photos_required ?? [],
    checklist: lists.checklist ?? [],
    alerts: alerts as Playbook["alerts"],
  };
}

function isPlaybookId(value: string | undefined): value is PlaybookId {
  return PLAYBOOK_IDS.includes(value as PlaybookId);
}
function isClass(value: string | undefined): value is RootCauseClass {
  return ROOT_CAUSE_CLASSES.includes(value as RootCauseClass);
}
function isLevel(value: string | undefined): value is PermissionLevel {
  return PERMISSION_LEVELS.includes(value as PermissionLevel);
}
function isAction(value: string | undefined): value is ActionId {
  return ACTION_IDS.includes(value as ActionId);
}
