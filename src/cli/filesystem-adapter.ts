import * as fs from "fs/promises";
import * as path from "path";
import type { ScanFileAccess, ScanInputFile } from "../scanner/core-scanner";
import { discoverFilesInDirectory } from "../scanner/file-discovery";

export async function createFilesystemScanAccess(targetPath: string): Promise<ScanFileAccess> {
  const resolved = path.resolve(targetPath);
  const stat = await fs.stat(resolved);
  const files: ScanInputFile[] = [];

  if (stat.isFile()) {
    files.push({
      absolutePath: resolved,
      relativePath: path.basename(resolved),
    });
  } else if (stat.isDirectory()) {
    const { files: discovered } = await discoverFilesInDirectory(resolved);
    files.push(...discovered);
  } else {
    throw new Error(`Unsupported scan target: ${targetPath}`);
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    files,
    readFile: async (absolutePath: string) => fs.readFile(absolutePath, "utf-8"),
  };
}
