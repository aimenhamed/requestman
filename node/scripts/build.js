import { buildClient } from "../build-client.js";

await buildClient(true);
console.log("Built client bundle to dist/");
