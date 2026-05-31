export const cloudProviders = ["kind", "aws", "azure", "gcp", "bare-metal"] as const;
export const tlsModes = ["self-signed", "http01", "dns01"] as const;
export const environments = ["uat", "prod"] as const;

export type CloudProvider = (typeof cloudProviders)[number];
export type TlsMode = (typeof tlsModes)[number];
export type EnvironmentName = (typeof environments)[number];

export interface BootstrapOptions {
  outputDir: string;
  customer: string;
  baseDomain: string;
  cloudProvider: CloudProvider;
  tlsMode: TlsMode;
  platformRepo: string;
  platformVersion: string;
  configRepo: string;
  force: boolean;
}

export interface GeneratedFile {
  path: string;
  content: string;
}
