import { apiMain } from "./api-export";

apiMain().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
