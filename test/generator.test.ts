import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { generateConfigRepo } from "../src/generator.js";
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
