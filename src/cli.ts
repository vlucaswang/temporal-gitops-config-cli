#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, input, select } from "@inquirer/prompts";
import { Command, Option } from "commander";
import { writeConfigRepo } from "./generator.js";
import { type BootstrapOptions, cloudProviders, tlsModes } from "./types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CliOptions {
  output?: string;
  customer?: string;
  domain?: string;
  cloudProvider?: BootstrapOptions["cloudProvider"];
  tls?: BootstrapOptions["tlsMode"];
  platformRepo?: string;
  platformVersion?: string;
  configRepo?: string;
  force?: boolean;
  yes?: boolean;
}

const program = new Command()
  .name("temporal-gitops-config")
  .description("Bootstrap per-customer Temporal GitOps config repositories.")
  .version("0.1.0");

program
  .command("bootstrap")
  .description("Generate a customer config repo skeleton with UAT and Prod environments.")
  .option("-o, --output <dir>", "output directory for the generated config repo")
  .option("--customer <name>", "customer slug, for example acme")
  .option("--domain <domain>", "base production domain, for example temporal.acme.com")
  .addOption(new Option("--cloud-provider <provider>", "cloud provider").choices([...cloudProviders]))
  .addOption(new Option("--tls <mode>", "TLS mode").choices([...tlsModes]))
  .option("--platform-repo <url>", "shared platform repo URL", "https://github.com/vlucaswang/k8s-templates.git")
  .option("--platform-version <revision>", "platform release tag or commit", "HEAD")
  .option("--config-repo <url>", "future customer config repo URL")
  .option("--force", "replace the output directory if it exists", false)
  .option("-y, --yes", "accept defaults and fail if required values are missing", false)
  .action(async (raw: CliOptions) => {
    const options = await collectOptions(raw);
    const files = await writeConfigRepo(options);
    console.log(`created ${files.length} files in ${options.outputDir}`);
    console.log(`platform version: ${options.platformVersion}`);
    console.log(`next: review ${options.outputDir}/docs/gitops-model.md`);
  });

program
  .command("doctor")
  .description("Check local CLI prerequisites.")
  .action(() => {
    console.log(`package root: ${packageRoot}`);
    console.log("node: ok");
  });

await program.parseAsync();

async function collectOptions(raw: CliOptions): Promise<BootstrapOptions> {
  const customer = raw.customer ?? await requiredInput(raw.yes, "customer", "Customer slug");
  const baseDomain = raw.domain ?? await requiredInput(raw.yes, "domain", "Base production domain");
  const outputDir = resolve(raw.output ?? `${customer}-temporal-config`);
  const cloudProvider = raw.cloudProvider ?? await select({
    message: "Cloud provider",
    choices: [
      { name: "kind", value: "kind" as const },
      { name: "AWS", value: "aws" as const },
      { name: "Azure", value: "azure" as const },
      { name: "GCP", value: "gcp" as const },
      { name: "Bare metal", value: "bare-metal" as const },
    ],
  });
  const tlsMode = raw.tls ?? await select({
    message: "TLS challenge mode",
    choices: [
      { name: "self-signed", value: "self-signed" as const },
      { name: "HTTP-01", value: "http01" as const },
      { name: "DNS-01", value: "dns01" as const },
    ],
  });

  const configRepo = raw.configRepo ?? `https://github.com/${customer}/temporal-config.git`;
  let force = raw.force ?? false;
  if (!force && existsSync(outputDir) && !raw.yes) {
    force = await confirm({ message: `${outputDir} exists. Replace it?`, default: false });
  }

  return {
    outputDir,
    customer,
    baseDomain,
    cloudProvider,
    tlsMode,
    platformRepo: raw.platformRepo ?? "https://github.com/vlucaswang/k8s-templates.git",
    platformVersion: raw.platformVersion ?? "HEAD",
    configRepo,
    force,
  };
}

async function requiredInput(yes: boolean | undefined, key: string, message: string): Promise<string> {
  if (yes) {
    throw new Error(`--${key} is required when --yes is set`);
  }
  return input({ message, required: true });
}
