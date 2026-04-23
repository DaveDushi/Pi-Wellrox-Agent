import { readdirSync } from "fs";
import { join } from "path";

export type TreeEntry =
  | { name: string; type: "folder"; children: TreeEntry[] }
  | { name: string; type: "file"; fullPath: string };

export function readTree(dir: string): TreeEntry[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.map((entry): TreeEntry => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return { name: entry.name, type: "folder", children: readTree(fullPath) };
    }
    return { name: entry.name, type: "file", fullPath };
  });
}
