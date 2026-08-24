import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

// Works from both src/ (tsx) and dist/ (compiled JavaScript).
export const projectRoot = path.resolve(sourceDir, "..");
export const publicDir = path.join(projectRoot, "public");
export const workspace = path.resolve(process.env.PI_WEB_WORKSPACE || process.cwd());

export function safePublicPath(urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const candidate = path.resolve(publicDir, `.${decoded}`);
  const relative = path.relative(publicDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return candidate;
}
