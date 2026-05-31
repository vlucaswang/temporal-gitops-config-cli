import YAML from "yaml";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bumpPlatformVersion, generateConfigRepo, writeConfigRepo } from "../src/generator.js";
import type { BootstrapOptions } from "../src/types.js";

const baseOptions: BootstrapOptions = {
  outputDir: "/tmp/acme-temporal-config",
  customer: "acme",
  baseDomain: "temporal.acme.test",
  cloudProvider: "azure",
  tlsMode: "dns01",
  platformRepo: "https://github.com/example/platform.git",
  platformVersion: "platform-v1.2.3",
  configRepo: "https://github.com/acme/temporal-config.git",
  force: true,
};

describe("generateConfigRepo", () => {
  it("generates uat and prod config with only cluster-specific values", () => {
    const files = generateConfigRepo(baseOptions);
    const paths = files.map((file) => file.path);

    expect(paths).toContain("environments/uat/cluster.yaml");
    expect(paths).toContain("environments/prod/cluster.yaml");
    expect(paths).toContain("platform-release.yaml");
    expect(paths).toContain("argocd/root-applicationset.yaml");

    const uat = parse(find(files, "environments/uat/cluster.yaml"));
    const prod = parse(find(files, "environments/prod/cluster.yaml"));

    expect(uat.spec.domain).toBe("uat.temporal.acme.test");
    expect(prod.spec.domain).toBe("temporal.acme.test");
    expect(uat.spec.cloud.provider).toBe("azure");
    expect(prod.spec.cloud.nodeCount).toBe(3);
    expect(prod.spec.tls.certManager.challenge.type).toBe("dns01");
  });

  it("pins Argo CD to the platform repo and explicit platform version", () => {
    const files = generateConfigRepo(baseOptions);
    const appset = parse(find(files, "argocd/root-applicationset.yaml"));

    expect(appset.spec.template.spec.sources[0]).toMatchObject({
      repoURL: "https://github.com/example/platform.git",
      targetRevision: "platform-v1.2.3",
      path: "gitops/apps",
    });
    expect(appset.spec.template.spec.sources[1]).toMatchObject({
      repoURL: "https://github.com/acme/temporal-config.git",
      ref: "config",
    });
  });

  it("bumps generated config repos to a new platform release", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "temporal-config-"));
    try {
      await writeConfigRepo({ ...baseOptions, outputDir: dir });
      const changed = await bumpPlatformVersion(dir, "platform-v1.2.4");

      expect(changed).toEqual(["platform-release.yaml", "argocd/root-applicationset.yaml"]);
      const release = parse(await readFile(path.join(dir, "platform-release.yaml"), "utf8"));
      const appset = parse(await readFile(path.join(dir, "argocd/root-applicationset.yaml"), "utf8"));

      expect(release.spec.targetRevision).toBe("platform-v1.2.4");
      expect(appset.spec.template.spec.sources[0].targetRevision).toBe("platform-v1.2.4");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

function find(files: { path: string; content: string }[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) {
    throw new Error(`missing generated file ${path}`);
  }
  return file.content;
}

function parse(content: string): any {
  return YAML.parse(content);
}
