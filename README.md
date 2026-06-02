# temporal-gitops-config-cli

TypeScript CLI for bootstrapping per-customer Temporal GitOps config repos.

The target operating model is a two-repo split:

- Platform repo: shared Helm chart catalog, production-tested defaults,
  NetworkPolicies, ServiceMonitors, and cert-manager conventions.
- Config repo: one per customer, with `uat` and `prod` values that genuinely
  vary by cluster.

Read [docs/two-repo-gitops.md](docs/two-repo-gitops.md) for the complete model.

## Usage

Interactive:

```sh
npx github:vlucaswang/temporal-gitops-config-cli bootstrap
```

Non-interactive:

```sh
npx github:vlucaswang/temporal-gitops-config-cli bootstrap \
  --customer acme \
  --domain temporal.acme.test \
  --cloud-provider azure \
  --tls dns01 \
  --platform-repo https://github.com/vlucaswang/k8s-templates.git \
  --platform-version platform-v1.0.0 \
  --config-repo https://github.com/acme/temporal-config.git \
  --output ./acme-temporal-config \
  --force \
  --yes
```

Bump a generated config repo to a new platform release:

```sh
npx github:vlucaswang/temporal-gitops-config-cli platform:bump \
  --repo ./acme-temporal-config \
  --platform-version platform-v1.4.0
```

Promote one environment first:

```sh
npx github:vlucaswang/temporal-gitops-config-cli platform:bump \
  --repo ./acme-temporal-config \
  --platform-version platform-v1.4.0 \
  --environment uat
```

## Validate

```sh
npm ci
npm run validate
```
