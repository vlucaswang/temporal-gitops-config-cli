import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  type BootstrapOptions,
  type CloudProvider,
  cloudProviders,
  type EnvironmentName,
  environments,
  type GeneratedFile,
  type TlsMode,
  tlsModes,
} from "./types.js";

const bootstrapSchema = z.object({
  outputDir: z.string().min(1),
  customer: z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  baseDomain: z.string().min(3),
  cloudProvider: z.enum(cloudProviders),
  tlsMode: z.enum(tlsModes),
  platformRepo: z.string().url(),
  platformVersion: z.string().min(1),
  configRepo: z.string().url(),
  force: z.boolean(),
});

export function validateOptions(options: BootstrapOptions): BootstrapOptions {
  return bootstrapSchema.parse(options);
}

export async function writeConfigRepo(options: BootstrapOptions): Promise<GeneratedFile[]> {
  const parsed = validateOptions(options);
  if (parsed.force) {
    await rm(parsed.outputDir, { force: true, recursive: true });
  }
  await mkdir(parsed.outputDir, { recursive: true });

  const files = generateConfigRepo(parsed);
  for (const file of files) {
    const target = path.join(parsed.outputDir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  return files;
}

export async function bumpPlatformVersion(
  configRepoDir: string,
  platformVersion: string,
  platformRepo?: string,
  environment: EnvironmentName | "all" = "all",
): Promise<string[]> {
  if (!platformVersion) {
    throw new Error("platformVersion is required");
  }

  const changed: string[] = [];
  const releasePath = path.join(configRepoDir, "platform-release.yaml");
  const appSetPath = path.join(configRepoDir, "argocd/root-applicationset.yaml");

  const release = YAML.parse(await readFile(releasePath, "utf8"));
  release.spec ??= {};
  release.spec.environments ??= {};
  for (const env of selectedEnvironments(environment)) {
    release.spec.environments[env] ??= {};
    release.spec.environments[env].targetRevision = platformVersion;
  }
  if (platformRepo) {
    release.spec.repoURL = platformRepo;
  }
  await writeFile(releasePath, yaml(release));
  changed.push("platform-release.yaml");

  const appSet = YAML.parse(await readFile(appSetPath, "utf8"));
  const sources = appSet?.spec?.template?.spec?.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("argocd/root-applicationset.yaml does not contain spec.template.spec.sources");
  }
  sources[0].targetRevision = "{{ .targetRevision }}";
  if (platformRepo) {
    sources[0].repoURL = platformRepo;
  }
  const elements = appSet?.spec?.generators?.[0]?.list?.elements;
  if (!Array.isArray(elements)) {
    throw new Error("argocd/root-applicationset.yaml does not contain spec.generators[0].list.elements");
  }
  for (const element of elements) {
    if (selectedEnvironments(environment).includes(element.env)) {
      element.targetRevision = platformVersion;
    }
  }
  await writeFile(appSetPath, yaml(appSet));
  changed.push("argocd/root-applicationset.yaml");

  return changed;
}

export function generateConfigRepo(options: BootstrapOptions): GeneratedFile[] {
  const parsed = validateOptions(options);
  const files: GeneratedFile[] = [
    file("README.md", readme(parsed)),
    file("docs/gitops-model.md", gitopsModelDoc(parsed)),
    file("platform-release.yaml", yaml({
      apiVersion: "platform.temporal.io/v1alpha1",
      kind: "PlatformRelease",
      metadata: { name: "temporal-platform" },
      spec: {
        repoURL: parsed.platformRepo,
        environments: Object.fromEntries(
          environments.map((env) => [env, { targetRevision: parsed.platformVersion }]),
        ),
        updatePolicy: "explicit-version-bump",
      },
    })),
    file("argocd/root-applicationset.yaml", rootApplicationSet(parsed)),
  ];

  for (const env of environments) {
    const domain = env === "prod" ? parsed.baseDomain : `${env}.${parsed.baseDomain}`;
    files.push(
      file(`environments/${env}/cluster.yaml`, clusterConfig(parsed, env, domain)),
      file(`values/${env}/temporal.yaml`, yaml({
        global: {
          customer: parsed.customer,
          environment: env,
          domain,
        },
        temporal: {
          frontendHost: `temporal.${domain}`,
          uiHost: `temporal-ui.${domain}`,
        },
      })),
      file(`values/${env}/edge.yaml`, yaml({
        gateway: {
          hostnames: {
            temporalFrontend: `temporal.${domain}`,
            temporalUi: `temporal-ui.${domain}`,
          },
        },
      })),
    );
  }

  return files;
}

function file(filePath: string, content: string): GeneratedFile {
  return { path: filePath, content: content.endsWith("\n") ? content : `${content}\n` };
}

function yaml(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0 });
}

function clusterConfig(options: BootstrapOptions, env: string, domain: string): string {
  return yaml({
    apiVersion: "platform.temporal.io/v1alpha1",
    kind: "ClusterConfig",
    metadata: { name: `${options.customer}-${env}` },
    spec: {
      customer: options.customer,
      environment: env,
      domain,
      platform: {
        repoURL: options.platformRepo,
        targetRevision: options.platformVersion,
      },
      cloud: cloudConfig(options.cloudProvider, env),
      tls: tlsConfig(options.tlsMode),
    },
  });
}

function cloudConfig(provider: CloudProvider, env: string): Record<string, unknown> {
  const base = {
    provider,
    nodeCount: env === "prod" ? 3 : 1,
  };
  switch (provider) {
    case "kind":
      return { ...base, kind: { loadBalancer: "cloud-provider-kind" } };
    case "aws":
      return { ...base, aws: { accountId: "", clusterRoleArn: "", region: "" } };
    case "azure":
      return {
        ...base,
        azure: { tenantId: "", subscriptionId: "", resourceGroup: "", workloadIdentityClientId: "" },
      };
    case "gcp":
      return { ...base, gcp: { projectId: "", region: "", workloadIdentityProvider: "" } };
    case "bare-metal":
      return { ...base, bareMetal: { loadBalancerPool: "" } };
  }
}

function tlsConfig(mode: TlsMode): Record<string, unknown> {
  switch (mode) {
    case "self-signed":
      return { mode, certManager: { issuerKind: "ClusterIssuer", issuerName: "self-signed" } };
    case "http01":
      return {
        mode,
        certManager: {
          issuerKind: "ClusterIssuer",
          issuerName: "letsencrypt-http01",
          challenge: { type: "http01", ingressClassName: "kgateway" },
        },
      };
    case "dns01":
      return {
        mode,
        certManager: {
          issuerKind: "ClusterIssuer",
          issuerName: "letsencrypt-dns01",
          challenge: { type: "dns01", provider: "", hostedZone: "" },
        },
      };
  }
}

function rootApplicationSet(options: BootstrapOptions): string {
  return yaml({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "ApplicationSet",
    metadata: { name: "temporal-platform-environments", namespace: "argocd" },
    spec: {
      goTemplate: true,
      goTemplateOptions: ["missingkey=error"],
      generators: [{
        list: {
          elements: environments.map((env) => ({
            env,
            namespace: `temporal-${env}`,
            targetRevision: options.platformVersion,
          })),
        },
      }],
      template: {
        metadata: {
          name: "temporal-platform-{{ .env }}",
          labels: {
            "app.kubernetes.io/part-of": "temporal-platform",
            "temporal.io/environment": "{{ .env }}",
          },
        },
        spec: {
          project: "temporal-kind",
          sources: [
            {
              repoURL: options.platformRepo,
              targetRevision: "{{ .targetRevision }}",
              path: "gitops/apps",
            },
            {
              repoURL: options.configRepo,
              targetRevision: "HEAD",
              ref: "config",
            },
          ],
          destination: {
            server: "https://kubernetes.default.svc",
            namespace: "{{ .namespace }}",
          },
          syncPolicy: {
            automated: { prune: true, selfHeal: true },
            syncOptions: ["CreateNamespace=true", "ServerSideApply=true"],
          },
        },
      },
    },
  });
}

function selectedEnvironments(environment: EnvironmentName | "all"): EnvironmentName[] {
  return environment === "all" ? [...environments] : [environment];
}

function readme(options: BootstrapOptions): string {
  return `# ${options.customer} Temporal Config

This is a per-customer config repo for the shared Temporal platform repo.

- Platform repo: \`${options.platformRepo}\`
- Platform version: \`${options.platformVersion}\`
- Config repo: \`${options.configRepo}\`
- Cloud provider: \`${options.cloudProvider}\`
- TLS mode: \`${options.tlsMode}\`
- Environments: \`uat\`, \`prod\`

Keep only customer and environment-specific values here: domains, node counts,
Azure IDs, AWS account roles, GCP identities, hosted zones, and TLS challenge
choices. Shared defaults stay in the platform repo and are consumed by changing
per-environment target revisions in \`platform-release.yaml\`.

Read [docs/gitops-model.md](docs/gitops-model.md) for the full two-repo model.
`;
}

function gitopsModelDoc(options: BootstrapOptions): string {
  return `# Two-Repo GitOps Model

This config repo is generated for \`${options.customer}\`. Argo CD watches this repo and
the shared platform repo.

## Platform Repo

The platform repo owns production-tested defaults and common operations logic:

- Helm chart catalog and chart versions.
- Cilium NetworkPolicies baked into each chart.
- Prometheus ServiceMonitors pre-wired.
- cert-manager annotations for the right challenge type.
- Shared Argo CD Application and ApplicationSet patterns.

Platform fixes should be released once, then adopted here by bumping the
environment entries in \`platform-release.yaml\`.

## Config Repo

This repo owns only values that genuinely vary by customer or cluster:

- domain names
- node counts
- cloud identities and account roles
- TLS challenge mode and provider details
- UAT and Prod environment overlays

## Release Flow

1. Fix or upgrade a shared behavior in the platform repo.
2. Tag a platform release, for example \`platform-v1.4.0\`.
3. Open a config repo PR bumping \`platform-release.yaml\`.
4. Let Argo CD reconcile UAT first.
5. Promote the same platform version to Prod after validation.

This mirrors the KubeAid-style separation of curated platform defaults from
cluster-specific config, while keeping adoption explicit per customer.
`;
}
