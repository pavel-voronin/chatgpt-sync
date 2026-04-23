import { resolveStartupConfig } from "./config/env";

const config = resolveStartupConfig(process.env);

console.log("chatgpt dialog sync scaffold ready");
console.log(`chrome profile dir: ${config.chromeProfileDir}`);
console.log(`output dir: ${config.outputDir}`);
console.log(`port: ${config.port}`);
