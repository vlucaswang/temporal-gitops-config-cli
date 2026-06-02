import YAML from "yaml";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bumpPlatformVersion, generateConfigRepo, writeConfigRepo } from "../src/generator.js";
import { cloudProviders, environments, tlsModes, type BootstrapOptions } from "../src/types.js";

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

    for (const env of environments) {
      expect(paths).toContain(`environments/${env}/cluster.yaml`);
      expect(paths).toContain(`values/${env}/temporal.yaml`);
      expect(paths).toContain(`values/${env}/edge.yaml`);
    }
    expect(paths).toContain("platform-release.yaml");
    expect(paths).toContain("argocd/root-applicationset.yaml");
    expect(paths.filter((filePath) => filePath.startsWith("environments/"))).toHaveLength(2);

    const uat = parse(find(files, "environments/uat/cluster.yaml"));
    const prod = parse(find(files, "environments/prod/cluster.yaml"));

    expect(uat.spec.domain).toBe("uat.temporal.acme.test");
    expect(prod.spec.domain).toBe("temporal.acme.test");
    expect(uat.spec.cloud.provider).toBe("azure");
    expect(prod.spec.cloud.nodeCount).toBe(3);
    expect(prod.spec.tls.certManager.challenge.type).toBe("dns01");
  });

  it("generates cloud-specific placeholders for every supported cloud provider", () => {
    for (const cloudProvider of cloudProviders) {
      const files = generateConfigRepo({ ...baseOptions, cloudProvider });
      const uat = parse(find(files, "environments/uat/cluster.yaml"));
      const prod = parse(find(files, "environments/prod/cluster.yaml"));

      expect(uat.spec.cloud.provider).toBe(cloudProvider);
      expect(uat.spec.cloud.nodeCount).toBe(1);
      expect(prod.spec.cloud.provider).toBe(cloudProvider);
      expect(prod.spec.cloud.nodeCount).toBe(3);

      switch (cloudProvider) {
        case "kind":
          expect(uat.spec.cloud.kind.loadBalancer).toBe("cloud-provider-kind");
          break;
        case "aws":
          expect(Object.keys(uat.spec.cloud.aws)).toEqual(["accountId", "clusterRoleArn", "region"]);
          break;
        case "azure":
          expect(Object.keys(uat.spec.cloud.azure)).toEqual([
            "tenantId",
            "subscriptionId",
            "resourceGroup",
            "workloadIdentityClientId",
          ]);
          break;
        case "gcp":
          expect(Object.keys(uat.spec.cloud.gcp)).toEqual(["projectId", "region", "workloadIdentityProvider"]);
          break;
        case "bare-metal":
          expect(Object.keys(uat.spec.cloud.bareMetal)).toEqual(["loadBalancerPool"]);
          break;
      }
    }
  });

  it("generates cert-manager settings for every supported TLS mode", () => {
    for (const tlsMode of tlsModes) {
      const files = generateConfigRepo({ ...baseOptions, tlsMode });
      const prod = parse(find(files, "environments/prod/cluster.yaml"));

      expect(prod.spec.tls.mode).toBe(tlsMode);
      expect(prod.spec.tls.certManager.issuerKind).toBe("ClusterIssuer");

      switch (tlsMode) {
        case "self-signed":
          expect(prod.spec.tls.certManager.issuerName).toBe("self-signed");
          expect(prod.spec.tls.certManager.challenge).toBeUndefined();
          break;
        case "http01":
          expect(prod.spec.tls.certManager.issuerName).toBe("letsencrypt-http01");
          expect(prod.spec.tls.certManager.challenge).toEqual({
            type: "http01",
            ingressClassName: "kgateway",
          });
          break;
        case "dns01":
          expect(prod.spec.tls.certManager.issuerName).toBe("letsencrypt-dns01");
          expect(prod.spec.tls.certManager.challenge).toEqual({
            type: "dns01",
            provider: "",
            hostedZone: "",
          });
          break;
      }
    }
  });

  it("pins Argo CD to the platform repo and explicit platform version", () => {
    const files = generateConfigRepo(baseOptions);
    const appset = parse(find(files, "argocd/root-applicationset.yaml"));
    const elements = appset.spec.generators[0].list.elements;

    expect(appset.spec.template.spec.sources[0]).toMatchObject({
      repoURL: "https://github.com/example/platform.git",
      targetRevision: "{{ .targetRevision }}",
      path: "gitops/apps",
    });
    expect(appset.spec.template.spec.sources[1]).toMatchObject({
      repoURL: "https://github.com/acme/temporal-config.git",
      ref: "config",
    });
    expect(elements).toEqual([
      { env: "uat", namespace: "temporal-uat", targetRevision: "platform-v1.2.3" },
      { env: "prod", namespace: "temporal-prod", targetRevision: "platform-v1.2.3" },
    ]);
  });

  it("bumps all generated config repo environments to a new platform release", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "temporal-config-"));
    try {
      await writeConfigRepo({ ...baseOptions, outputDir: dir });
      const changed = await bumpPlatformVersion(dir, "platform-v1.2.4");

      expect(changed).toEqual(["platform-release.yaml", "argocd/root-applicationset.yaml"]);
      const release = parse(await readFile(path.join(dir, "platform-release.yaml"), "utf8"));
      const appset = parse(await readFile(path.join(dir, "argocd/root-applicationset.yaml"), "utf8"));

      expect(release.spec.environments.uat.targetRevision).toBe("platform-v1.2.4");
      expect(release.spec.environments.prod.targetRevision).toBe("platform-v1.2.4");
      expect(appset.spec.template.spec.sources[0].targetRevision).toBe("{{ .targetRevision }}");
      expect(appset.spec.generators[0].list.elements).toEqual([
        { env: "uat", namespace: "temporal-uat", targetRevision: "platform-v1.2.4" },
        { env: "prod", namespace: "temporal-prod", targetRevision: "platform-v1.2.4" },
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("bumps one generated config repo environment at a time", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "temporal-config-"));
    try {
      await writeConfigRepo({ ...baseOptions, outputDir: dir });
      const changed = await bumpPlatformVersion(dir, "platform-v1.2.4", undefined, "uat");

      expect(changed).toEqual(["platform-release.yaml", "argocd/root-applicationset.yaml"]);
      const release = parse(await readFile(path.join(dir, "platform-release.yaml"), "utf8"));
      const appset = parse(await readFile(path.join(dir, "argocd/root-applicationset.yaml"), "utf8"));

      expect(release.spec.environments.uat.targetRevision).toBe("platform-v1.2.4");
      expect(release.spec.environments.prod.targetRevision).toBe("platform-v1.2.3");
      expect(appset.spec.generators[0].list.elements).toEqual([
        { env: "uat", namespace: "temporal-uat", targetRevision: "platform-v1.2.4" },
        { env: "prod", namespace: "temporal-prod", targetRevision: "platform-v1.2.3" },
      ]);
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
