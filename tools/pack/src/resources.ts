import { readFileSync } from "node:fs";
import { chmod, cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveToolsPackRoot(startDir: string): string {
  const maxDepth = 6;
  let current = startDir;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    try {
      const raw = readFileSync(join(current, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (parsed.name === "@open-design/tools-pack") {
        return current;
      }
    } catch {
      // Keep walking until we find the tools-pack package root.
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`tools-pack: unable to resolve package root from ${startDir}`);
}

export const toolsPackRoot = resolveToolsPackRoot(dirname(fileURLToPath(import.meta.url)));
export const resourcesRoot = join(toolsPackRoot, "resources");

export const macResources = {
  entitlements: join(resourcesRoot, "mac", "entitlements.mac.plist"),
  entitlementsInherit: join(resourcesRoot, "mac", "entitlements.mac.inherit.plist"),
  icon: join(resourcesRoot, "mac", "icon.icns"),
  iconPng: join(resourcesRoot, "mac", "icon.png"),
  notarizeHook: join(resourcesRoot, "mac", "notarize.cjs"),
  webStandaloneAfterPackHook: join(resourcesRoot, "web-standalone-after-pack.cjs"),
} as const;

export const winResources = {
  icon: join(resourcesRoot, "win", "icon.ico"),
  sevenZipDll: join(resourcesRoot, "win", "7zip", "7z.dll"),
  sevenZipExe: join(resourcesRoot, "win", "7zip", "7z.exe"),
  webStandaloneAfterPackHook: join(resourcesRoot, "web-standalone-after-pack.cjs"),
} as const;

export const linuxResources = {
  icon: join(resourcesRoot, "linux", "icon.png"),
  desktopTemplate: join(resourcesRoot, "linux", "open-design.desktop.template"),
} as const;

export const VELA_CLI_BIN_ENV = "OPEN_DESIGN_VELA_CLI_BIN";
type VelaCliPlatform = "linux" | "mac" | "win";
type VelaCliResolveResult =
  | string
  | null
  | undefined
  | {
      path?: string | null;
      supported?: boolean;
    };
type VelaCliResolverModule = {
  resolveVelaCliBin?: (options?: { strict?: boolean }) => VelaCliResolveResult | Promise<VelaCliResolveResult>;
};

const BUNDLED_RESOURCE_TREES = [
  { from: "skills", to: "skills" },
  // After the skills/design-templates split (specs/current/skills-and-design-templates.md)
  // the rendering catalogue lives under its own root and the daemon
  // resolves it via DESIGN_TEMPLATES_DIR. Bundle it like any other
  // first-class resource so packaged builds carry the full template set.
  { from: "design-templates", to: "design-templates" },
  { from: "design-systems", to: "design-systems" },
  { from: "craft", to: "craft" },
  { from: join("plugins", "_official"), to: join("plugins", "_official") },
  { from: join("plugins", "registry"), to: join("plugins", "registry") },
  { from: join("assets", "frames"), to: "frames" },
  { from: join("assets", "community-pets"), to: "community-pets" },
  { from: "prompt-templates", to: "prompt-templates" },
] as const;

export async function copyBundledResourceTrees({
  workspaceRoot,
  resourceRoot,
}: {
  workspaceRoot: string;
  resourceRoot: string;
}): Promise<void> {
  for (const entry of BUNDLED_RESOURCE_TREES) {
    await cp(join(workspaceRoot, entry.from), join(resourceRoot, entry.to), {
      recursive: true,
    });
  }
}

export async function copyOptionalVelaCliBinary({
  env = process.env,
  importPackage,
  platform,
  requireBundled = false,
  resourceRoot,
}: {
  env?: NodeJS.ProcessEnv;
  importPackage?: (packageName: string) => Promise<VelaCliResolverModule>;
  platform: VelaCliPlatform;
  requireBundled?: boolean;
  resourceRoot: string;
}): Promise<{ source: string; target: string } | null> {
  const source = await resolveOptionalVelaCliBinary({ env, importPackage, requireBundled });
  if (source == null) return null;
  const target = join(resourceRoot, "bin", platform === "win" ? "vela.exe" : "vela");
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
  if (platform !== "win") {
    await chmod(target, 0o755);
  }
  return { source, target };
}

export async function resolveOptionalVelaCliBinary({
  env = process.env,
  importPackage = async (packageName: string) => import(packageName) as Promise<VelaCliResolverModule>,
  requireBundled = false,
}: {
  env?: NodeJS.ProcessEnv;
  importPackage?: (packageName: string) => Promise<VelaCliResolverModule>;
  requireBundled?: boolean;
} = {}): Promise<string | null> {
  const envSource = env[VELA_CLI_BIN_ENV]?.trim();
  if (envSource) return envSource;

  let resolver: VelaCliResolverModule;
  try {
    resolver = await importPackage("@powerformer/vela-cli");
  } catch (error) {
    if (requireBundled) {
      throw new Error(
        "unable to resolve bundled Vela CLI: install @powerformer/vela-cli or set OPEN_DESIGN_VELA_CLI_BIN",
        { cause: error },
      );
    }
    return null;
  }

  if (typeof resolver.resolveVelaCliBin !== "function") {
    if (requireBundled) {
      throw new Error(
        "unable to resolve bundled Vela CLI: @powerformer/vela-cli must export resolveVelaCliBin or set OPEN_DESIGN_VELA_CLI_BIN",
      );
    }
    return null;
  }

  const resolved = await resolver.resolveVelaCliBin({ strict: requireBundled });
  if (typeof resolved === "string") {
    const normalized = resolved.trim();
    if (normalized.length > 0) return normalized;
  }
  if (resolved && typeof resolved === "object" && typeof resolved.path === "string") {
    const normalized = resolved.path.trim();
    if (normalized.length > 0) return normalized;
  }
  if (requireBundled) {
    throw new Error(
      "unable to resolve bundled Vela CLI: @powerformer/vela-cli returned no binary path; set OPEN_DESIGN_VELA_CLI_BIN to override",
    );
  }
  return null;
}
