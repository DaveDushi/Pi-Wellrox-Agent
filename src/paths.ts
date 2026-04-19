import { join } from "path";

interface PathConfig {
  userData: string;
  appRoot: string;
  resources: string;
}

const defaults: PathConfig = {
  userData: process.cwd(),
  appRoot: process.cwd(),
  resources: process.cwd(),
};

let current: PathConfig = { ...defaults };

export function configurePaths(overrides: Partial<PathConfig>): void {
  current = { ...current, ...overrides };
}

export function getUserDataDir(): string {
  return current.userData;
}

export function getAppRoot(): string {
  return current.appRoot;
}

export function getResourcesRoot(): string {
  return current.resources;
}

export function getPublicDir(): string {
  return join(current.appRoot, "public");
}

export function getDataDir(): string {
  return join(current.userData, "data");
}

export function getPiDir(): string {
  return join(current.userData, ".pi");
}

export function getSkillsDir(): string {
  return join(current.resources, "skills");
}
