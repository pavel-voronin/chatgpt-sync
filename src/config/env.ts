import {
  DEFAULT_CHROME_PROFILE_DIR,
  DEFAULT_PORT,
  DEFAULT_OUTPUT_DIR,
} from "./constants";

export type StartupConfig = {
  port: number;
  chromeProfileDir: string;
  outputDir: string;
};

function parsePort(input: string | undefined): number {
  const parsed = Number.parseInt(String(input ?? DEFAULT_PORT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    return DEFAULT_PORT;
  }
  return parsed;
}

export function resolveStartupConfig(env: NodeJS.ProcessEnv): StartupConfig {
  return {
    port: parsePort(env.PORT),
    chromeProfileDir:
      env.CHROME_PROFILE_DIR?.trim() || DEFAULT_CHROME_PROFILE_DIR,
    outputDir: env.OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR,
  };
}
